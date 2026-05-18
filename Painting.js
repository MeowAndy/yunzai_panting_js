import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch'; // 用于远程拉取焚决

if (!global.segment) {
  (async () => {
    try {
      global.segment = (await import('icqq')).segment;
    } catch {
      try {
        global.segment = (await import('oicq')).segment;
      } catch {
        global.segment = {
          image: (url) => ({ type: 'image', url }),
          text: (text) => ({ type: 'text', text }),
          at: (qq) => ({ type: 'at', qq })
        };
      }
    }
  })();
}
let segment = global.segment || {
  image: (url) => ({ type: 'image', url }),
  text: (text) => ({ type: 'text', text }),
  at: (qq) => ({ type: 'at', qq })
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== 核心配置 ==========
const API_URL = 'https://api地址/chat/completions';  //举例：https://api.fzmandy.fun/v1/images/generations
const API_KEY = "";//Apikey填这里
const MODEL_NAME = "gpt-5.5";

// ========== gpt-image-2 快速生图配置 ==========
const IMAGE_API_URL = "api地址/images/generations";  //举例：https://api.fzmandy.fun/v1/images/generations
const IMAGE_MODEL_NAME = "gpt-image-2";

// ========== 余额查询专用配置 ==========
const BALANCE_BASE_URL = 'https://your-balance-api-url'; //查余额api地址
const RENDER_CONFIG = {
  url: 'http://127.0.0.1:7005/puppeteer',
  token: 'your-render-token'
};

// ========== 超时与多图配置 [v1.1.0 新增] ==========
const API_TIMEOUT = 240000;        // [v1.1.0 新增] API请求超时时间(毫秒)，gpt-image-2 最长约3分钟，设为4分钟避免堆积
const BNN_MAX_COUNT = 5;           // #bnn 单次最多生成图片数量，防止滥用

// ========== 目录与文件 ==========
const DATA_DIR = path.resolve(__dirname, '../data');
const PRESET_FILE = path.join(DATA_DIR, 'ht.json'); 
const USER_COUNT_FILE = path.join(DATA_DIR, 'user_counts.json');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_stats.json');
const SAVE_CONFIG_FILE = path.join(DATA_DIR, 'save_config.json');
const SAVE_IMG_DIR = path.join(DATA_DIR, 'generated_images');
const REMOTE_JSON_URL = "https://ht.pippi.top/pippi.json"; 
const INITIAL_USER_COUNT = 10;
const PROXY_URL = "http://192.168.100.2:7890";
let USE_PROXY = false;
const CONVERT_IMAGE_TO_BASE64 = true;
const USE_IMAGE_PROXY = false;

export class Painting extends plugin {
  constructor() {
    super({
      name: "Painting",
      dsc: "画图及余额查询插件",
      event: "message",
      priority: -Infinity,
      rule: [
        { reg: "^#?(绘图更新预设|更新焚决)$", fnc: "updateResourcesHandler" },
        { reg: "^#?__NO_MATCH_PRESET__$", fnc: "makeFigurine" },
        { reg: "^#bnn(\\d*)\\s+([\\s\\S]+)$", fnc: "makeBnn" }, // [v1.1.0 改动] 支持 #bnn3 多图语法
        { reg: "^#绘图帮助$", fnc: "showHelp" },
        { reg: "^#绘图增加次数\\s*(\\d+)?(?:\\s+(.+))?$", fnc: "addUsageCount" },
        { reg: "^#绘图查询(所有|全部)次数$", fnc: "queryAllCounts" },
        { reg: "^#绘图删除(所有|全部)次数$", fnc: "deleteAllCounts" },
        { reg: "^#绘图查询次数(?:\\s+(.+))?$", fnc: "queryUsageCount" },
        { reg: "^#绘图删除次数(?:\\s+(.+))?$", fnc: "deleteUsageCount" },
        // 新增查询额度规则
        { reg: "^#?(查询额度|查余额|查询api|查api)$", fnc: "queryApi" },
        // 存图开关
        { reg: "^#开启bnn存图$", fnc: "enableSaveImg" },
        { reg: "^#关闭bnn存图$", fnc: "disableSaveImg" }
      ]
    });
    
    this.presetGroup = [];
    this.saveImgEnabled = false;
    this.ensureDir(DATA_DIR);
    this.loadSaveImgConfig();
    this.initResources();
  }

  // ================= 预设/焚决管理逻辑 =================
  async initResources() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    if (!fs.existsSync(PRESET_FILE)) {
      console.log("[Painting] 检测到预设文件 ht.json 缺失，正在自动从云端下载...");
      await this.fetchAndSaveJson();
    } else {
      this.loadPresetsFromFile();
    }
  }

  loadPresetsFromFile() {
    try {
      if (fs.existsSync(PRESET_FILE)) {
        const rawData = fs.readFileSync(PRESET_FILE, "utf-8");
        this.presetGroup = JSON.parse(rawData);
        this.updateReg(); 
      }
    } catch (err) {
      console.error(`[Painting] 读取 ht.json 失败: ${err.message}`);
    }
  }

  async fetchAndSaveJson() {
    try {
      const res = await fetch(REMOTE_JSON_URL, { timeout: 15000 });
      if (!res.ok) throw new Error(`请求失败，状态码: ${res.status}`);
      const data = await res.json();
      
      if (!Array.isArray(data)) throw new Error("远程数据格式错误，不是一个数组");
      
      fs.writeFileSync(PRESET_FILE, JSON.stringify(data, null, 2), "utf-8");
      this.loadPresetsFromFile();
      console.log(`[Painting] ✅ 预设更新成功，已加载 ${this.presetGroup.length} 条指令。`);
      return true;
    } catch (err) {
      console.error(`[Painting] ❎ 下载预设 JSON 失败: ${err.message}`);
      return false;
    }
  }

  updateReg() {
    if (this.presetGroup && this.presetGroup.length > 0) {
      const presetKeywords = this.presetGroup
        .flatMap((p) => p.keywords)
        .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      this.presetReg = new RegExp(`^#?(${presetKeywords})(?:@(\\d+)|(\\d+))?$`);
    } else {
      this.presetReg = /^#?__NO_MATCH_PRESET__$/;
    }
    const presetRule = this.rule.find((r) => r.fnc === "makeFigurine");
    if (presetRule) {
      presetRule.reg = this.presetReg;
    }
  }

  async updateResourcesHandler(e) {
    if (!e.isMaster) return e.reply(`哼唧，只有主人才能更新菲比的魔法书哦~ 🙅‍♀️`);
    
    await e.reply("正在从云端拉取最新魔法预设，请稍等...", true);
    const jsonSuccess = await this.fetchAndSaveJson();
    
    if (!jsonSuccess) {
      return e.reply("更新失败啦，请查看后台控制台日志。🥺", true);
    }
    await e.reply(`✅ 魔法书更新成功！\n已加载 ${this.presetGroup.length} 条神奇咒语。✨`, true);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  getUsageId(e) { return e.isGroup ? String(e.group_id) : null; }
  getUserId(e) { return `user_${e.user_id}`; }

  getDailyStatsConfig() {
    this.ensureDir(DATA_DIR);
    if (!fs.existsSync(DAILY_STATS_FILE)) {
      const def = { date: new Date().toDateString(), totalGenerated: 0, historyTotal: 0, lastReset: new Date().toISOString() };
      fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(def, null, 2));
      return def;
    }
    try {
      const data = JSON.parse(fs.readFileSync(DAILY_STATS_FILE, 'utf8'));
      const today = new Date().toDateString();
      if (data.date !== today) {
        if (data.totalGenerated > 0) data.historyTotal = (data.historyTotal || 0) + data.totalGenerated;
        data.date = today;
        data.totalGenerated = 0;
        data.lastReset = new Date().toISOString();
        this.saveDailyStatsConfig(data);
      }
      if (data.historyTotal === undefined) data.historyTotal = 0;
      return data;
    } catch {
      const def = { date: new Date().toDateString(), totalGenerated: 0, historyTotal: 0, lastReset: new Date().toISOString() };
      fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(def, null, 2));
      return def;
    }
  }

  saveDailyStatsConfig(cfg) {
    this.ensureDir(DATA_DIR);
    fs.writeFileSync(DAILY_STATS_FILE, JSON.stringify(cfg, null, 2));
  }

  async getTodayGeneratedCount() { return this.getDailyStatsConfig().totalGenerated || 0; }

  async increaseTodayGeneratedCount() {
    const cfg = this.getDailyStatsConfig();
    cfg.totalGenerated = (cfg.totalGenerated || 0) + 1;
    this.saveDailyStatsConfig(cfg);
    return cfg.totalGenerated;
  }

  async getHistoryTotalCount() { return this.getDailyStatsConfig().historyTotal || 0; }

  getUsageCountConfig() {
    this.ensureDir(DATA_DIR);
    if (!fs.existsSync(USER_COUNT_FILE)) {
      const def = { users: {} };
      fs.writeFileSync(USER_COUNT_FILE, JSON.stringify(def, null, 2));
      return def;
    }
    try {
      const data = JSON.parse(fs.readFileSync(USER_COUNT_FILE, 'utf8'));
      if (!data.users) data.users = {};
      return data;
    } catch {
      const def = { users: {} };
      fs.writeFileSync(USER_COUNT_FILE, JSON.stringify(def, null, 2));
      return def;
    }
  }

  saveUsageCountConfig(cfg) {
    this.ensureDir(DATA_DIR);
    fs.writeFileSync(USER_COUNT_FILE, JSON.stringify(cfg, null, 2));
  }

  async getUsageCount(id) {
    if (!id) return 0;
    const cfg = this.getUsageCountConfig();
    if (cfg.users[id] === undefined) {
      cfg.users[id] = INITIAL_USER_COUNT;
      this.saveUsageCountConfig(cfg);
    }
    return cfg.users[id] || 0;
  }

  async setUsageCount(id, count) {
    if (!id) return;
    const cfg = this.getUsageCountConfig();
    cfg.users[id] = count;
    this.saveUsageCountConfig(cfg);
  }

  async decreaseUsageCount(id, count = 1) {
    if (!id) return;
    const currentCount = await this.getUsageCount(id);
    await this.setUsageCount(id, Math.max(0, currentCount - count));
  }

  // === 次数管理命令 ===
  async addUsageCount(e) {
    if (!e.isMaster) return e.reply(`哼唧，这个是主人的专属魔法，菲比不能听你的哦~ 🙅‍♀️`);

    const rawMsg = e.msg.replace(/^#绘图增加次数/, '').trim();
    const parts = rawMsg.split(/\s+/);
    const count = parseInt(parts[0] || 0);

    if (isNaN(count) || count <= 0) return e.reply('唔...充值的次数必须是正整数才行呀！✨');

    let targetId = null;
    let typeStr = "";

    if (e.at) {
        targetId = `user_${e.at}`;
        typeStr = `用户 ${e.at}`;
    } else if (parts[1]) {
        if (parts[1].toLowerCase().startsWith('u')) {
            const uid = parts[1].substring(1);
            targetId = `user_${uid}`;
            typeStr = `用户 ${uid}`;
        } else {
            targetId = parts[1];
            typeStr = `群 ${targetId}`;
        }
    } else {
        if (e.isGroup) {
            targetId = String(e.group_id);
            typeStr = "本群";
        } else {
            targetId = `user_${e.user_id}`;
            typeStr = `你(专属)`;
        }
    }

    const current = await this.getUsageCount(targetId);
    await this.setUsageCount(targetId, current + count);
    
    await e.reply(`好耶！菲比已经为 ${typeStr} 增加了 ${count} 次魔法✨\n🎁 当前剩余：${current + count} 次哟~ 💖`);
  }

  async queryUsageCount(e) {
    await e.reply(`菲比正在翻看账本，请稍等哦… 📖`);
    
    const todayGenerated = await this.getTodayGeneratedCount();
    const historyTotal = await this.getHistoryTotalCount();
    
    let targetId = null;
    let typeStr = "";
    const rawMsg = e.msg.replace(/^#绘图查询次数/, '').trim();

    if (e.at) {
        targetId = `user_${e.at}`;
        typeStr = `用户 ${e.at}`;
    } else if (e.isMaster && rawMsg) {
        if (rawMsg.toLowerCase().startsWith('u')) {
            const uid = rawMsg.match(/\d+/)?.[0];
            if (uid) { targetId = `user_${uid}`; typeStr = `用户 ${uid}`; }
        } else {
            const gid = rawMsg.match(/\d+/)?.[0];
            if (gid) { targetId = gid; typeStr = `群 ${gid}`; }
        }
    }

    if (!targetId) {
        if (e.isGroup) {
            const groupCount = await this.getUsageCount(String(e.group_id));
            const userCount = await this.getUsageCount(`user_${e.user_id}`);
            await e.reply(`本群的剩余魔法次数：${groupCount} 次 ✨\n你个人的专属魔法次数：${userCount} 次 🎁\n\n📊 菲比今日全服作画：${todayGenerated}张\n🏆 菲比历史总共作画：${historyTotal}张`);
            return;
        } else {
            targetId = `user_${e.user_id}`;
            typeStr = "你的专属";
        }
    }
    
    const count = await this.getUsageCount(targetId);
    await e.reply(`${typeStr} 的剩余魔法次数：${count} 次 ✨\n\n📊 菲比今日全服作画：${todayGenerated}张\n🏆 菲比历史总共作画：${historyTotal}张`);
  }

  async queryAllCounts(e) {
    if (!e.isMaster) return e.reply(`哼唧，这个是主人的专属魔法，菲比不能听你的哦~ 🙅‍♀️`);
    
    const cfg = this.getUsageCountConfig();
    const list = Object.entries(cfg.users).filter(([_, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    
    if (list.length === 0) return e.reply(`报告主人！菲比的账本上还没有任何次数记录哦~ 📝`);
    
    const total = list.reduce((acc, cur) => acc + cur[1], 0);
    let info = [`📊 菲比的魔法账本：`, `总计分配: ${total} 次`, '----------------'];
    
    list.slice(0, 50).forEach((item, i) => {
        const typeLabel = item[0].startsWith('user_') ? `用户 ${item[0].substring(5)}` : `群 ${item[0]}`;
        info.push(`${i+1}. ${typeLabel}: ${item[1]} 次`);
    });
    
    if (list.length > 50) info.push(`...以及其他 ${list.length - 50} 个目标`);
    
    const forwardMsg = await this.makeForwardMsg(e, info, `菲比的魔法账本`);
    await e.reply(forwardMsg || info.join('\n'));
  }

  async deleteUsageCount(e) {
    if (!e.isMaster) return e.reply(`哼唧，这个是主人的专属魔法，菲比不能听你的哦~ 🙅‍♀️`);
    let targetId = null, typeStr = "";

    if (e.at) {
        targetId = `user_${e.at}`; typeStr = `用户 ${e.at}`;
    } else {
        const rawMsg = e.msg.replace(/^#绘图删除次数/, '').trim();
        if (rawMsg) {
            if (rawMsg.toLowerCase().startsWith('u')) {
                const uid = rawMsg.match(/\d+/)?.[0];
                if (uid) { targetId = `user_${uid}`; typeStr = `用户 ${uid}`; }
            } else {
                const gid = rawMsg.match(/\d+/)?.[0];
                if (gid) { targetId = gid; typeStr = `群 ${gid}`; }
            }
        }
    }
    
    if (!targetId) {
        if (e.isGroup) { targetId = String(e.group_id); typeStr = "本群"; } 
        else { return e.reply(`菲比不知道你要清零谁，请指定一下哦：#绘图删除次数 <群号/uQQ号/@某人> 🧹`); }
    }
    
    const cfg = this.getUsageCountConfig();
    if (cfg.users[targetId]) {
        delete cfg.users[targetId];
        this.saveUsageCountConfig(cfg);
        await e.reply(`呼~ 菲比已经把 ${typeStr} 的魔法次数清空啦！🧹`);
    } else {
        await e.reply(`咦？${typeStr} 还没有菲比的次数记录呢 🐾`);
    }
  }

  async deleteAllCounts(e) {
    if (!e.isMaster) return e.reply(`哼唧，这个是主人的专属魔法，菲比不能听你的哦~ 🙅‍♀️`);
    const cfg = this.getUsageCountConfig();
    cfg.users = {};
    this.saveUsageCountConfig(cfg);
    await e.reply(`好啦！菲比已经把全服所有的次数记录都打扫干净啦！✨`);
  }

  async takeSourceMsg(e, { img, file } = {}) {
    let source = "";
    if (e.getReply) { source = await e.getReply(); } 
    else if (e.source) {
      if (e.group?.getChatHistory) { source = (await e.group.getChatHistory(e.source.seq, 1)).pop(); } 
      else if (e.friend?.getChatHistory) { source = (await e.friend.getChatHistory(e.source.time, 1)).pop(); }
    }
    if (!source) return false;

    if (img) {
      let imgArr = [];
      for (let i of source.message) { if (i.type == "image") imgArr.push(i.url); }
      return imgArr.length > 0 ? imgArr : false;
    }
    return source;
  }

  async getImageUrls(e, useAvatarFallback = true) {
    let imageUrlList = [];

    if (e.getReply || e.source) {
      const replyImgs = await this.takeSourceMsg(e, { img: true });
      if (replyImgs && replyImgs.length > 0) imageUrlList.push(...replyImgs);
    }
    
    const imgSegments = e.message.filter(m => m.type === "image");
    if (imgSegments.length > 0) {
      for (const imgSeg of imgSegments) { if (imgSeg.url) imageUrlList.push(imgSeg.url); }
    }

    const atSegments = e.message.filter(m => m.type === "at");
    const atQQs = atSegments.map(atSeg => atSeg.qq).filter(qq => qq);
    
    for (const qq of atQQs) {
        const isGhostAt = e.source && String(qq) === String(e.source.user_id);
        if (!isGhostAt || imageUrlList.length === 0) {
            const avatarUrl = await this.getAvatarUrl(qq);
            imageUrlList.push(avatarUrl);
        }
    }
    
    if (imageUrlList.length === 0 && useAvatarFallback) {
      const avatarUrl = await this.getAvatarUrl(e.user_id);
      imageUrlList.push(avatarUrl);
    }
    return [...new Set(imageUrlList)];
  }

  getSafeImageUrl(url) {
      if (!url) return "";
      if (url.startsWith("data:")) return url;
      if (USE_IMAGE_PROXY) return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=jpg`;
      return url;
  }

  extractImagesFromResponse(data) {
    const msg = data?.choices?.[0]?.message;
    const imageUrls = [];

    if (Array.isArray(msg?.content)) {
      for (const item of msg.content) {
        if (item?.type === "image_url" && item?.image_url?.url) imageUrls.push(item.image_url.url);
      }
    }

    if (imageUrls.length === 0 && typeof msg?.content === "string") {
      const mdImageRegex = /!\[.*?\]\((.*?)\)/g;
      let match;
      while ((match = mdImageRegex.exec(msg.content)) !== null) {
        let url = match[1];
        if (url.startsWith("data:image")) url = url.replace(/^data:image\/\w+;base64,/, "base64://");
        imageUrls.push(url);
      }
    }

    if (imageUrls.length === 0) {
        if (data?.choices?.[0]?.message?.images?.[0]) {
            let url = data.choices[0].message.images[0].image_url?.url || data.choices[0].message.images[0].url;
            imageUrls.push(url);
        } else if (data?.data?.[0]?.url) {
            imageUrls.push(data.data[0].url);
        }
    }
    return imageUrls;
  }

  // === 核心：读取动态正则匹配并进行生图 ===
  async makeFigurine(e) {
    if (!e.isMaster) {
      const groupId = this.getUsageId(e);
      const userId = this.getUserId(e);
      const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
      const userCount = await this.getUsageCount(userId);

      if (groupCount < 1 && userCount < 1) {
        if (!groupId) await e.reply("呜呜，这个魔法需要消耗次数哦，你的专属次数不足啦，快去请主人充值吧~ 🎀");
        else await e.reply(`哎呀，本群和你的专属魔法次数都已经用完啦，快去请主人给菲比充值吧~ ✨`);
        return;
      }
    }

    const startTime = Date.now();
    const cmdMatch = e.msg.match(this.presetReg);
    if (!cmdMatch) return;
    
    const cmd = cmdMatch[1]; 
    const preset = this.presetGroup.find(p => p.keywords.includes(cmd));
    if (!preset) return;
    const prompt = preset.prompt;
    const presetName = preset.keywords[0];

    await e.reply(`🪄 菲比收到 [${presetName}] 指令啦，正在为你施展魔法，请稍等哦… 🎨`);
    
    const imageUrlList = await this.getImageUrls(e, true);
    if (preset.needImage && imageUrlList.length === 0) {
        await e.reply("呀，这个魔法需要你发送一张参考图片给我哦~ 🖼️");
        return;
    }
    
    const imageUrl = imageUrlList[0];
    let finalImageUrl = imageUrl;
    
    if (CONVERT_IMAGE_TO_BASE64) {
        let base64Data = null;
        for (let retry = 0; retry < 2; retry++) {
          try {
            base64Data = await this.urlToBase64(imageUrl);
            break;
          } catch (err) {
            console.error(`图片转Base64失败(第${retry+1}次):`, err.message || err);
            if (retry === 0) await this.sleep(1000);
          }
        }
        if (base64Data) {
          finalImageUrl = `data:image/jpeg;base64,${base64Data}`;
        } else {
          await e.reply("呜呜，菲比获取你发的图片失败了（可能图片已过期），请重新发送图片试试哦~ 🥺");
          return;
        }
    } else {
        finalImageUrl = this.getSafeImageUrl(imageUrl);
    }
    
    let imageContent = { type: "image_url", image_url: { url: finalImageUrl } };

    const payload = {
      model: MODEL_NAME,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            imageContent
          ]
        }
      ],
      max_tokens: 1000,
      stream: false
    };
    await this.callApiAndReply(e, payload, startTime, presetName);
  }

  async makeBnn(e) { // [v1.1.0 改动] 支持 #bnn3 多图生成语法
    if (!e.isMaster) {
      const groupId = this.getUsageId(e);
      const userId = this.getUserId(e);
      const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
      const userCount = await this.getUsageCount(userId);

      if (groupCount < 1 && userCount < 1) {
        if (!groupId) await e.reply(`呜呜，菲比的这个魔法需要消耗次数哦，你的专属次数不足，快去请主人充值吧~ 🎀`);
        else await e.reply(`哎呀，本群和你的专属魔法次数都已经用完啦，快去请主人给菲比充值吧~ ✨`);
        return;
      }
    }

    const startTime = Date.now();
    const MAX_IMAGES = 5;

    // [v1.1.0 改动] 解析 #bnn<数量> <提示词> 格式
    const match = e.msg.match(/^#bnn(\d*)\s+([\s\S]+)$/);
    if (!match || !match[2]) {
      await e.reply("格式不对啦！正确咒语是：#bnn <提示词> [图片] 或 #bnn3 <提示词> 生成多张 🪄");
      return;
    }
    // [v1.1.0 改动] 解析生成数量，默认1，最大为 BNN_MAX_COUNT
    let genCount = match[1] ? parseInt(match[1]) : 1;
    if (isNaN(genCount) || genCount < 1) genCount = 1;
    if (genCount > BNN_MAX_COUNT) {
      await e.reply(`最多一次生成 ${BNN_MAX_COUNT} 张哦，菲比帮你调整到 ${BNN_MAX_COUNT} 张啦~ 🎨`);
      genCount = BNN_MAX_COUNT;
    }
    const prompt = match[2].trim();

    // [v1.1.0 改动] 检查次数是否足够（多图时需要多次）
    if (!e.isMaster) {
      const groupId = this.getUsageId(e);
      const userId = this.getUserId(e);
      const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
      const userCount = await this.getUsageCount(userId);
      const totalAvailable = groupCount + userCount;
      if (totalAvailable < genCount) {
        await e.reply(`你的剩余次数(${totalAvailable})不够生成 ${genCount} 张哦，菲比帮你调整到 ${totalAvailable} 张~ 🎁`);
        genCount = totalAvailable;
        if (genCount < 1) return;
      }
    }

    const imageUrlList = await this.getImageUrls(e, false);
    const originalCount = imageUrlList.length;
    let replyMessage = '';

    if (originalCount === 0) replyMessage = genCount > 1 
      ? `收到！菲比正在生成 ${genCount} 张图，请耐心等待哦… 💭✨`
      : `收到！菲比正在根据提示词闭眼想象，马上画出来哦… 💭✨`;
    else if (originalCount > MAX_IMAGES) {
      imageUrlList.splice(MAX_IMAGES);
      replyMessage = genCount > 1
        ? `哇！图片太多啦，菲比挑了前 ${MAX_IMAGES} 张，正在生成 ${genCount} 张图… 🪄`
        : `哇！图片太多啦，菲比挑了前 ${MAX_IMAGES} 张，结合提示词开始施展魔法啦… 🪄`;
    } else replyMessage = genCount > 1
      ? `收到 ${originalCount} 张图片！菲比正在生成 ${genCount} 张图，请稍等… 🎨`
      : `收到 ${originalCount} 张图片！菲比正在结合提示词努力作画中… 🎨`;

    await e.reply(replyMessage);
    
    let contentPayload = [{ type: "text", text: prompt }];
    
    let failedImages = 0;
    for (const url of imageUrlList) {
      let finalUrl = url;
      if (CONVERT_IMAGE_TO_BASE64) {
        let base64Data = null;
        // 尝试两次下载图片
        for (let retry = 0; retry < 2; retry++) {
          try {
            base64Data = await this.urlToBase64(url);
            break;
          } catch (err) {
            console.error(`图片转Base64失败(第${retry+1}次):`, err.message || err);
            if (retry === 0) await this.sleep(1000);
          }
        }
        if (base64Data) {
          finalUrl = `data:image/jpeg;base64,${base64Data}`;
        } else {
          console.error("[Painting] 图片下载彻底失败，跳过该图:", url);
          failedImages++;
          continue; // 跳过这张无法获取的图片，不要把无效URL发给API
        }
      } else finalUrl = this.getSafeImageUrl(url);
      
      contentPayload.push({ type: "image_url", image_url: { url: finalUrl } });
    }
    // 如果所有图片都失败了，提示用户
    if (failedImages > 0 && contentPayload.length <= 1) {
      await e.reply("呜呜，菲比获取你发的图片失败了（可能图片已过期），请重新发送图片试试哦~ 🥺");
      return;
    }
    if (failedImages > 0) {
      await e.reply(`⚠️ 有 ${failedImages} 张图片获取失败，菲比用剩余的图片继续画哦~`);
    }

    const payload = {
      model: MODEL_NAME,
      messages: [{ role: "user", content: contentPayload }],
      max_tokens: 1000, stream: false, temperature: 0.6
    };

    // [v1.2.1 修复] 有图片时走 chat/completions (gpt-5.5能看图)，无图片时走 gpt-image-2
    if (genCount === 1 && originalCount === 0) {
      const imgPromptSingle = contentPayload.map(c => c.type === 'text' ? c.text : '[图片]').join(' ');
      const imgPayloadSingle = JSON.stringify({
        model: IMAGE_MODEL_NAME,
        prompt: imgPromptSingle,
        n: 1,
        size: "1024x1024"
      });
      try {
        const res = await this.fetchWithProxy(IMAGE_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
          body: imgPayloadSingle
        });
        let data;
        try { data = await res.json(); } catch (parseErr) {
          await e.reply(`生成失败: 响应解析错误 ${parseErr.message}`); return;
        }
        if (data.error) { await e.reply(`生成失败: ${data.error.message || '未知API错误'}`); return; }
        const imgData = data.data && data.data[0];
        if (!imgData) { await e.reply('生成失败: 响应中未找到图片数据'); return; }
        
        // 存图功能
        await this.saveGeneratedImage(imgData, e, 0);

        let imgSegment;
        if (imgData.b64_json) {
          imgSegment = segment.image(`base64://${imgData.b64_json}`);
        } else if (imgData.url) {
          if (CONVERT_IMAGE_TO_BASE64) {
            const base64Data = await this.urlToBase64(imgData.url);
            imgSegment = segment.image(`base64://${base64Data}`);
          } else {
            imgSegment = segment.image(imgData.url);
          }
        } else { await e.reply('生成失败: 响应中未找到图片数据'); return; }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const todayCount = await this.increaseTodayGeneratedCount();
        let countInfo = "";
        if (!e.isMaster) {
          const groupId = this.getUsageId(e);
          const userId = this.getUserId(e);
          const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
          const userCount = await this.getUsageCount(userId);
          if (groupCount >= 1) {
            await this.decreaseUsageCount(groupId, 1);
            countInfo = `\n📊 全服作画：${todayCount}张\n🎁 本群魔法余量：${groupCount - 1}次`;
          } else if (userCount >= 1) {
            await this.decreaseUsageCount(userId, 1);
            countInfo = `\n📊 全服作画：${todayCount}张\n🎁 你的专属魔法余量：${userCount - 1}次`;
          } else {
            countInfo = `\n📊 全服作画：${todayCount}张\n⚠️ 魔法已经用光光啦`;
          }
        } else {
          countInfo = `\n📊 全服作画：${todayCount}张\n👑 主人拥有无限魔法！`;
        }
        const replyText = `\n✨ 铛铛铛！画好啦，耗时 ${elapsed}s ｜类型：${originalCount === 0 ? "文生图" : "自定义创作"}${countInfo}`;
        await e.reply([replyText, imgSegment]);
      } catch (err) {
        await e.reply(`生成失败: ${err.message || err}`);
      }
      return;
    } else if (genCount > 1 && originalCount === 0) {
      // 多图生成（无参考图）：串行调用 gpt-image-2
      const results = []; // 收集成功的图片 segment
      let successCount = 0;
      const maxRetries = 3;

      // [v1.2.0 改动] 多图走 gpt-image-2 images/generations 接口，速度快很多
      const imgPrompt = contentPayload.map(c => c.type === 'text' ? c.text : '[图片]').join(' ');
      for (let i = 0; i < genCount; i++) {
        let lastError = null;
        let generated = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (attempt > 1) await this.sleep(Math.min(1000 * attempt, 5000));
          try {
            const imgPayload = JSON.stringify({
              model: IMAGE_MODEL_NAME,
              prompt: imgPrompt,
              n: 1,
              size: "1024x1024"
            });
            const res = await this.fetchWithProxy(IMAGE_API_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
              body: imgPayload
            });

            let data;
            try { data = await res.json(); } catch (parseErr) {
              lastError = parseErr.message; continue;
            }
            if (data.error) { lastError = data.error.message || '未知API错误'; continue; }

            // gpt-image-2 returns data[].b64_json or data[].url
            const imgData = data.data && data.data[0];
            if (imgData) {
              // 存图功能
              await this.saveGeneratedImage(imgData, e, i);

              let imgSegment;
              if (imgData.b64_json) {
                imgSegment = segment.image(`base64://${imgData.b64_json}`);
              } else if (imgData.url) {
                if (CONVERT_IMAGE_TO_BASE64) {
                  const base64Data = await this.urlToBase64(imgData.url);
                  imgSegment = segment.image(`base64://${base64Data}`);
                } else {
                  imgSegment = segment.image(imgData.url);
                }
              } else {
                lastError = '响应中未找到图片数据'; continue;
              }
              results.push(imgSegment);
              successCount++;
              generated = true;
              break;
            } else {
              lastError = '响应中未找到图片数据'; continue;
            }
          } catch (err) { lastError = String(err); continue; }
        }

        if (!generated) {
          results.push({ type: 'text', text: `第 ${i + 1} 张生成失败: ${lastError}` });
        }
      }

      // [v1.1.0 改动] 次数消耗按实际成功数量扣
      const cost = successCount;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      if (successCount > 0) {
        // 统计今日生成数
        for (let i = 0; i < successCount; i++) {
          await this.increaseTodayGeneratedCount();
        }
        const todayCount = await this.getTodayGeneratedCount();

        // 扣除次数
        let countInfo = "";
        if (!e.isMaster) {
          const groupId = this.getUsageId(e);
          const userId = this.getUserId(e);
          let remaining = cost;
          const groupCount = groupId ? await this.getUsageCount(groupId) : 0;

          if (groupCount >= remaining) {
            await this.decreaseUsageCount(groupId, remaining);
            countInfo = `\n📊 全服作画：${todayCount}张\n🎁 本群魔法余量：${groupCount - remaining}次`;
          } else {
            // 先扣群次数，不够再扣个人
            if (groupCount > 0) {
              await this.decreaseUsageCount(groupId, groupCount);
              remaining -= groupCount;
            }
            const userCount = await this.getUsageCount(userId);
            await this.decreaseUsageCount(userId, remaining);
            countInfo = `\n📊 全服作画：${todayCount}张\n🎁 你的专属魔法余量：${userCount - remaining}次`;
          }
        } else {
          const todayCountFinal = await this.getTodayGeneratedCount();
          countInfo = `\n📊 全服作画：${todayCountFinal}张\n👑 主人拥有无限魔法！`;
        }

        // 用合并转发发送多图
        let forwardMsgList = [];
        for (let i = 0; i < results.length; i++) {
          forwardMsgList.push(results[i]);
        }
        forwardMsgList.push(`✨ 铛铛铛！${successCount}/${genCount} 张画好啦，总耗时 ${elapsed}s${countInfo}`);

        const forwardMsg = await this.makeForwardMsg(e, forwardMsgList, `菲比的 ${successCount} 张画作`);
        if (forwardMsg) {
          await e.reply(forwardMsg);
        } else {
          // 合并转发失败，逐条发送
          for (const item of results) {
            await e.reply(item);
          }
          await e.reply(`✨ ${successCount}/${genCount} 张画好啦，总耗时 ${elapsed}s${countInfo}`);
        }
      } else {
        await e.reply(`呜呜呜...${genCount} 张图全部生成失败了 (${elapsed}s) 🥺`);
      }
    } else {
      // [v1.4.0] 有参考图片时，走 Responses API + image_generation tool，一步到位
      const RESPONSES_URL = API_URL.replace('/v1/chat/completions', '/v1/responses');

      // 构建 input content：文本 + 图片
      let inputContent = [{ type: "input_text", text: prompt }];
      for (const c of contentPayload) {
        if (c.type === 'image_url') {
          inputContent.push({ type: "input_image", image_url: c.image_url.url });
        }
      }

      const responsesPayload = {
        model: MODEL_NAME,
        input: [{ role: "user", content: inputContent }],
        tools: [{ type: "image_generation" }]
      };

      if (genCount === 1) {
        // 单图
        try {
          const res = await this.fetchWithProxy(RESPONSES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
            body: JSON.stringify(responsesPayload)
          });
          let data;
          try { data = await res.json(); } catch (parseErr) { await e.reply(`生成失败: 响应解析错误 ${parseErr.message}`); return; }
          if (data.error) { await e.reply(`生成失败: ${data.error.message || JSON.stringify(data.error)}`); return; }

          // 从 output 中提取图片
          let imgBase64 = null;
          for (const item of (data.output || [])) {
            if (item.type === 'image_generation_call' && item.result) {
              imgBase64 = item.result;
              break;
            }
          }
          if (!imgBase64) { await e.reply('生成失败: 响应中未找到图片数据'); return; }

          const imgSegment = segment.image(`base64://${imgBase64}`);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          const todayCount = await this.increaseTodayGeneratedCount();
          let countInfo = "";
          if (!e.isMaster) {
            const groupId = this.getUsageId(e);
            const userId = this.getUserId(e);
            const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
            const userCount = await this.getUsageCount(userId);
            if (groupCount >= 1) { await this.decreaseUsageCount(groupId, 1); countInfo = `\n📊 全服作画：${todayCount}张\n🎁 本群魔法余量：${groupCount - 1}次`; }
            else if (userCount >= 1) { await this.decreaseUsageCount(userId, 1); countInfo = `\n📊 全服作画：${todayCount}张\n🎁 你的专属魔法余量：${userCount - 1}次`; }
            else { countInfo = `\n📊 全服作画：${todayCount}张\n⚠️ 魔法已经用光光啦`; }
          } else { countInfo = `\n📊 全服作画：${todayCount}张\n👑 主人拥有无限魔法！`; }
          const replyText = `\n✨ 铛铛铛！画好啦，耗时 ${elapsed}s ｜类型：图生图${countInfo}`;
          await e.reply([imgSegment, { type: 'text', text: replyText }]);
        } catch (err) { await e.reply(`生成失败: ${err.message || err}`); }
      } else {
        // 多图生成：串行调用 Responses API
        const results = [];
        let successCount = 0;
        const maxRetries = 3;

        for (let i = 0; i < genCount; i++) {
          let lastError = null;
          let generated = false;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (attempt > 1) await this.sleep(Math.min(1000 * attempt, 5000));
            try {
              const res = await this.fetchWithProxy(RESPONSES_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
                body: JSON.stringify(responsesPayload)
              });
              let data;
              try { data = await res.json(); } catch (parseErr) { lastError = parseErr.message; continue; }
              if (data.error) { lastError = data.error.message || JSON.stringify(data.error); continue; }

              let imgBase64 = null;
              for (const item of (data.output || [])) {
                if (item.type === 'image_generation_call' && item.result) {
                  imgBase64 = item.result;
                  break;
                }
              }
              if (imgBase64) {
                results.push(segment.image(`base64://${imgBase64}`));
                successCount++; generated = true; break;
              } else { lastError = '响应中未找到图片数据'; continue; }
            } catch (err) { lastError = String(err); continue; }
          }
          if (!generated) { results.push({ type: 'text', text: `第 ${i + 1} 张生成失败: ${lastError}` }); }
        }

        const cost = successCount;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successCount > 0) {
          for (let i = 0; i < successCount; i++) { await this.increaseTodayGeneratedCount(); }
          const todayCount = await this.getTodayGeneratedCount();
          let countInfo = "";
          if (!e.isMaster) {
            const groupId = this.getUsageId(e);
            const userId = this.getUserId(e);
            let remaining = cost;
            const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
            if (groupCount >= remaining) { await this.decreaseUsageCount(groupId, remaining); countInfo = `\n📊 全服作画：${todayCount}张\n🎁 本群魔法余量：${groupCount - remaining}次`; }
            else {
              if (groupCount > 0) { await this.decreaseUsageCount(groupId, groupCount); remaining -= groupCount; }
              const userCount = await this.getUsageCount(userId);
              await this.decreaseUsageCount(userId, remaining);
              countInfo = `\n📊 全服作画：${todayCount}张\n🎁 你的专属魔法余量：${userCount - remaining}次`;
            }
          } else { countInfo = `\n📊 全服作画：${await this.getTodayGeneratedCount()}张\n👑 主人拥有无限魔法！`; }

          let forwardMsgList = [...results];
          forwardMsgList.push(`✨ 铛铛铛！${successCount}/${genCount} 张画好啦，总耗时 ${elapsed}s ｜类型：图生图${countInfo}`);
          const forwardMsg = await this.makeForwardMsg(e, forwardMsgList, `菲比的 ${successCount} 张画作`);
          if (forwardMsg) { await e.reply(forwardMsg); }
          else { for (const item of results) { await e.reply(item); } await e.reply(`✨ ${successCount}/${genCount} 张画好啦，总耗时 ${elapsed}s ｜类型：图生图${countInfo}`); }
        } else {
          await e.reply(`呜呜呜...${genCount} 张图全部生成失败了 (${elapsed}s) 🥺`);
        }
      }
    }
  }

  // ================= 存图功能 =================
  loadSaveImgConfig() {
    try {
      if (fs.existsSync(SAVE_CONFIG_FILE)) {
        const data = JSON.parse(fs.readFileSync(SAVE_CONFIG_FILE, 'utf8'));
        this.saveImgEnabled = !!data.enabled;
      }
    } catch (err) {
      console.error(`[Painting] 读取存图配置失败: ${err.message}`);
    }
  }

  saveSaveImgConfig() {
    fs.writeFileSync(SAVE_CONFIG_FILE, JSON.stringify({ enabled: this.saveImgEnabled }, null, 2));
  }

  async enableSaveImg(e) {
    if (!e.isMaster) return e.reply('哼唧，只有主人才能开启存图哦~ 🙅‍♀️');
    this.saveImgEnabled = true;
    this.saveSaveImgConfig();
    this.ensureDir(SAVE_IMG_DIR);
    await e.reply('✅ 已开启bnn存图！生成的图片会保存到本地 data/generated_images/ 目录 📁');
    return true;
  }

  async disableSaveImg(e) {
    if (!e.isMaster) return e.reply('哼唧，只有主人才能关闭存图哦~ 🙅‍♀️');
    this.saveImgEnabled = false;
    this.saveSaveImgConfig();
    await e.reply('✅ 已关闭bnn存图！后续生成的图片不再保存到本地 🚫');
    return true;
  }

  async saveGeneratedImage(imgData, e, index = 0) {
    if (!this.saveImgEnabled) return;
    try {
      this.ensureDir(SAVE_IMG_DIR);
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      const userId = e.user_id || 'unknown';
      const filename = `${dateStr}_${timeStr}_${userId}_${index}.png`;
      const filepath = path.join(SAVE_IMG_DIR, filename);

      let buffer;
      if (imgData.b64_json) {
        buffer = Buffer.from(imgData.b64_json, 'base64');
      } else if (imgData.url) {
        const base64Data = await this.urlToBase64(imgData.url);
        buffer = Buffer.from(base64Data, 'base64');
      }
      if (buffer) {
        fs.writeFileSync(filepath, buffer);
        console.log(`[Painting] 💾 图片已保存: ${filename}`);
      }
    } catch (err) {
      console.error(`[Painting] 存图失败: ${err.message}`);
    }
  }

  async showHelp(e) {
    let forwardMsgList = []; 
    forwardMsgList.push(`🎨 菲比Painting魔法使用帮助：`);
    if (this.presetGroup && this.presetGroup.length > 0) {
      const lines = this.presetGroup.map((p, index) => {
        const keys = p.keywords.join(" / ");
        return `${index + 1}. #${keys}`;
      });
      forwardMsgList.push(`📌 基础咒语 (读取自云端，会消耗群魔法/个人魔法)：\n${lines.join("\n")}`);
    } else {
      forwardMsgList.push(`📌 基础咒语：\n暂无本地预设，请发送 #更新焚决 获取。`);
    }
    forwardMsgList.push(`📌 创作咒语：
#bnn <提示词> [图片] - 菲比看图作画
#bnn <提示词> - 菲比闭眼想象作画 (纯文生图)

📌 次数与魔法机制：
消耗【群次数】。如果群次数不足，菲比会自动检查【你的个人专属次数】哦！`);
    forwardMsgList.push(`📌 主人专属指令：
#绘图更新预设 (或 #更新焚决) - 从云端拉取最新的画图咒语
#绘图增加次数 <数量> [@某人/uQQ号/群号] - 给群或个人充能
#绘图查询/删除所有次数 - 管理全服魔法账本
#绘图删除次数 [@某人/uQQ号/群号] - 清空某个记录
#查询额度 (或 #查余额) - 查询 API 中转站余额状态
#开启bnn存图 - 开启本地存图（图片保存到 data/generated_images/）
#关闭bnn存图 - 关闭本地存图（默认关闭）

📌 大家都可以用的：
#绘图查询次数 - 看看群里和个人的魔法余量`);
    const forwardMsg = await this.makeForwardMsg(e, forwardMsgList, `菲比的魔法使用帮助`);
    if (forwardMsg) {
        await e.reply(forwardMsg);
    } else {
        await e.reply(`哎呀，菲比制作魔法帮助手册(合并转发)失败啦，请检查Bot是否有发送合并转发的权限哦~ 🥺`);
    }

    return true;
  }

  async getAvatarUrl(qq) { return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`; }

  async fetchWithProxy(url, options = {}) {
    let agent = null;
    if (USE_PROXY) agent = new HttpsProxyAgent(PROXY_URL);

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const requestOptions = {
        hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search, method: options.method || 'GET',
        headers: options.headers || {}, agent: agent, timeout: API_TIMEOUT // [v1.1.0 改动] 使用配置常量，设为4分钟
      };

      const req = httpModule.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const data = buffer.toString();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode, statusText: res.statusMessage,
            headers: new Map(Object.entries(res.headers)), text: () => Promise.resolve(data),
            json: () => {
              try { return Promise.resolve(JSON.parse(data)); }
              catch (e) { return Promise.reject(e); }
            },
            arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
          });
        });
      });

      req.on('error', (err) => { reject(err); });
      req.on('timeout', () => { reject(new Error(`请求超时`)); });
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async urlToBase64(url) {
    const res = await this.fetchWithProxy(url);
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  }

  async callApiAndReply(e, payload, startTime, presetName = "", cost = 1) {
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) await this.sleep(Math.min(1000 * attempt, 5000));
      try {
        const res = await this.fetchWithProxy(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
          body: JSON.stringify(payload)
        });

        let data;
        try { data = await res.json(); } catch (parseErr) {
          lastError = { reason: `响应解析失败(${res.status})`, error: parseErr.message }; continue;
        }

        if (data.error) { lastError = { reason: "API返回错误", error: data.error.message || '未知API错误' }; continue; }

        const extractedImages = this.extractImagesFromResponse(data);
        const genImageUrl = extractedImages.length > 0 ? extractedImages[0] : null;

        if (genImageUrl) {
          let processedImageUrl = genImageUrl;
          if (CONVERT_IMAGE_TO_BASE64 && genImageUrl.startsWith('http')) {
             const base64Data = await this.urlToBase64(genImageUrl);
             processedImageUrl = `base64://${base64Data}`;
          } else if (genImageUrl.startsWith('data:image/')) {
             const base64Data = genImageUrl.split(',')[1];
             processedImageUrl = `base64://${base64Data}`;
          }
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
          const todayCount = await this.increaseTodayGeneratedCount();
          let countInfo = "";
          
          if (!e.isMaster) {
            const groupId = this.getUsageId(e);
            const userId = this.getUserId(e);
            const groupCount = groupId ? await this.getUsageCount(groupId) : 0;
            const userCount = await this.getUsageCount(userId);

            if (groupCount >= cost) {
              await this.decreaseUsageCount(groupId, cost);
              countInfo = `\n📊 全服作画：${todayCount}张\n🎁 本群魔法余量：${groupCount - cost}次`;
            } else if (userCount >= cost) {
              await this.decreaseUsageCount(userId, cost);
              countInfo = `\n📊 全服作画：${todayCount}张\n🎁 你的专属魔法余量：${userCount - cost}次`;
            } else {
              countInfo = `\n📊 全服作画：${todayCount}张\n⚠️ 魔法已经用光光啦`;
            }
          } else {
            countInfo = `\n📊 全服作画：${todayCount}张\n👑 主人拥有无限魔法！`;
          }
          
          const replyText = presetName 
            ? `\n✨ 铛铛铛！画好啦，耗时 ${elapsed}s ｜类型：${presetName}${countInfo}`
            : `\n✨ 铛铛铛！画好啦，耗时 ${elapsed}s ${countInfo}`;
          
          let imgSegment;
          if (processedImageUrl.startsWith('base64://') || processedImageUrl.startsWith('http')) {
               imgSegment = segment.image(processedImageUrl);
          } else if (processedImageUrl.startsWith('data:image')) {
               imgSegment = segment.image(processedImageUrl.replace(/^data:image\/\w+;base64,/, "base64://"));
          } else {
               imgSegment = { type: 'image', file: processedImageUrl };
          }

          await e.reply([imgSegment, { type: 'text', text: replyText }]);
          return;
        } else {
          lastError = { reason: "响应中未找到图片数据", content: data?.choices?.[0]?.message?.content || "无内容" }; continue;
        }
      } catch (err) { lastError = { reason: "请求失败", error: String(err), attempt }; continue; }
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    await e.reply(`呜呜呜...画画失败了 (${elapsed}s，尝试了${maxRetries}次)\n💣 报错啦: ${lastError?.reason || '未知'}\n🔍 小本本记录: ${lastError?.error || lastError?.content || '无'} 🥺`);
  }

  async sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  
  async makeForwardMsg(e, msg = [], dec = '') {
    let userInfo = { nickname: e.sender.card || e.sender.nickname, user_id: e.sender.user_id };
    let forwardMsg = msg.map(v => ({ ...userInfo, message: v }));
    try {
      let res = e.isGroup ? await e.group.makeForwardMsg(forwardMsg) : await e.friend.makeForwardMsg(forwardMsg);
      if (dec && res && typeof res.data === 'object' && res.data?.meta?.detail) {
         const detail = JSON.parse(res.data.meta.detail);
         detail.news = [{ text: dec }];
         res.data.meta.detail = JSON.stringify(detail);
      }
      return res;
    } catch (err) { return false; }
  }

  // ================= 余额查询及渲染逻辑 =================

  async generateImage(htmlTemplate, e, prefix = 'api_dashboard') {
    const saveDir = path.join(DATA_DIR, 'api_temp');
    this.ensureDir(saveDir);
    
    const htmlFileName = `${prefix}_${Date.now()}.html`;
    const htmlPath = path.resolve(`${saveDir}/${htmlFileName}`);
    fs.writeFileSync(htmlPath, htmlTemplate, 'utf-8');

    let finalImg = null;
    const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;

    // === 降级策略 1：尝试 Karin 外置渲染 ===
    try {
      const body = {
        file: fileUrl, 
        selector: 'body', 
        type: 'png', 
        quality: 100, 
        encoding: 'base64',
        pageGotoParams: { waitUntil: 'networkidle0' }
      };

      const response = await fetch(RENDER_CONFIG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'authorization': RENDER_CONFIG.token },
        body: JSON.stringify(body),
        timeout: 3000
      });

      if (response.ok) {
        const base64Body = await response.text(); 
        finalImg = base64Body.startsWith('base64://') ? base64Body : `base64://${base64Body}`;
        try {
          const jsonRes = JSON.parse(base64Body);
          if(jsonRes && jsonRes.data) finalImg = `base64://${jsonRes.data}`;
        } catch(err) {}
      } else {
        console.warn(`[API查询] Karin渲染失败 (HTTP ${response.status})，准备降级。`);
      }
    } catch (err) {
      console.warn(`[API查询] Karin渲染服务不可达，转为内置渲染...`);
    }

    // === 降级策略 2：尝试 Yunzai 内置 Puppeteer 渲染 ===
    if (!finalImg) {
      try {
        const puppeteer = (await import('../../lib/puppeteer/puppeteer.js')).default;
        if (puppeteer && puppeteer.browser) {
          const browser = await puppeteer.browserInit() || puppeteer.browser;
          if (browser) {
            const page = await browser.newPage();
            await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 8000 });
            finalImg = await page.screenshot({ type: 'png', fullPage: true });
            await page.close();
            console.log(`[API查询] 已使用内置 Puppeteer 完成渲染。`);
          }
        }
      } catch (err) {
        console.error(`[API查询] 内置 Puppeteer 渲染也失败了: ${err.message}`);
      }
    }

    // 延迟清理临时HTML文件
    setTimeout(() => { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath) }, 5000);

    return finalImg;
  }

  getCommonCSS() {
    return `
    :root {
      --primary: #00f2fe; --secondary: #4facfe; --danger: #ff4b2b; --success: #00b09b;
      --bg-main: #0f172a; --panel-bg: rgba(30, 41, 59, 0.6); --text-main: #f8fafc;
      --text-muted: #94a3b8; --border: rgba(255, 255, 255, 0.1);
    }
    body { background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%); color: var(--text-main); font-family: 'PingFang SC', sans-serif; padding: 30px; width: 700px; margin: 0; box-sizing: border-box; }
    .glass-card { background: var(--panel-bg); border: 1px solid var(--border); border-top: 1px solid rgba(255,255,255,0.2); border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); backdrop-filter: blur(12px); padding: 25px; margin-bottom: 25px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .title { font-size: 26px; font-weight: bold; background: linear-gradient(to right, var(--primary), var(--secondary)); -webkit-background-clip: text; color: transparent; margin: 0; }
    .status-badge { display: flex; align-items: center; background: rgba(0,176,155,0.2); border: 1px solid var(--success); color: var(--success); padding: 5px 15px; border-radius: 20px; font-size: 14px; font-weight: bold; }
    .status-dot { width: 8px; height: 8px; background: var(--success); border-radius: 50%; margin-right: 8px; box-shadow: 0 0 8px var(--success); }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
    .stat-item { text-align: center; padding: 15px 0; position: relative; }
    .stat-item:not(:last-child)::after { content: ''; position: absolute; right: 0; top: 20%; height: 60%; width: 1px; background: var(--border); }
    .stat-val { font-size: 28px; font-weight: bold; font-family: 'Trebuchet MS', sans-serif; color: #fff; text-shadow: 0 0 10px rgba(255,255,255,0.3); }
    .stat-lbl { font-size: 13px; color: var(--text-muted); margin-top: 8px; text-transform: uppercase; letter-spacing: 1px; }
    .progress-wrap { margin-top: 25px; }
    .progress-header { display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
    .progress-bar-bg { width: 100%; height: 8px; background: rgba(0,0,0,0.4); border-radius: 4px; overflow: hidden; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5); }
    .progress-bar-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; box-shadow: 0 0 10px rgba(0,242,254,0.5); }
    .section-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; display: flex; align-items: center; color: #fff; }
    .section-title::before { content: ''; width: 4px; height: 18px; background: var(--primary); margin-right: 10px; border-radius: 2px; }
    .log-list { display: flex; flex-direction: column; gap: 12px; }
    .log-item { display: flex; align-items: center; padding: 15px; background: rgba(0,0,0,0.25); border-radius: 12px; border: 1px solid transparent; transition: all 0.3s; }
    .log-item:nth-child(1) { border-color: rgba(0,242,254,0.3); background: rgba(0,242,254,0.05); }
    .log-icon { width: 40px; height: 40px; border-radius: 10px; margin-right: 15px; box-shadow: 0 4px 10px rgba(79,172,254,0.3); flex-shrink: 0; overflow: hidden; background: #000; }
    .log-icon img { width: 100%; height: 100%; object-fit: cover; }
    .log-info { flex: 1; }
    .log-model { font-size: 16px; font-weight: bold; color: var(--text-main); margin-bottom: 4px; }
    .log-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 15px; }
    .log-quota { text-align: right; }
    .quota-val { font-size: 18px; font-weight: bold; color: var(--primary); font-family: 'Trebuchet MS', sans-serif; }
    .quota-lbl { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    `;
  }

  buildHtml(limit, used, remaining, logs, botUin) {
    const percent = limit > 0 ? Math.min((used / limit) * 100, 100).toFixed(1) : 0;
    let progressColor = percent > 80 ? 'linear-gradient(90deg, #f093fb 0%, #f5576c 100%)' : 'linear-gradient(90deg, #4facfe 0%, #00f2fe 100%)';

    let html = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><style>${this.getCommonCSS()}</style></head><body>
    <div class="glass-card">
      <div class="header"><h1 class="title">API 运行状态监测看板</h1><div class="status-badge"><div class="status-dot"></div>服务在线</div></div>
      <div class="stats-grid">
        <div class="stat-item"><div class="stat-val">$${limit.toFixed(2)}</div><div class="stat-lbl">总限额 (Hard Limit)</div></div>
        <div class="stat-item"><div class="stat-val" style="color: #ff758c;">$${used.toFixed(2)}</div><div class="stat-lbl">已消耗 (Total Usage)</div></div>
        <div class="stat-item"><div class="stat-val" style="color: #00b09b;">$${remaining.toFixed(2)}</div><div class="stat-lbl">剩余可用 (Remaining)</div></div>
      </div>
      <div class="progress-wrap">
        <div class="progress-header"><span>额度消耗比例</span><span style="color: #fff; font-weight: bold;">${percent}%</span></div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${percent}%; background: ${progressColor};"></div></div>
      </div>
    </div>
    <div class="glass-card" style="padding: 20px 25px;"><div class="section-title">最新调用日志 (Top 5)</div><div class="log-list">`;

    if (logs.length === 0) {
      html += `<div style="text-align: center; color: var(--text-muted); padding: 20px;">暂无调用记录</div>`;
    } else {
      logs.forEach((item) => {
        let time = new Date(item.created_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        let tokenName = item.token_name ? item.token_name.split('-')[0] : '未知';
        let actualCost = (item.quota / 500000).toFixed(6);
        
        html += `
        <div class="log-item">
          <div class="log-icon"><img src="https://q1.qlogo.cn/g?b=qq&nk=${botUin}&s=100" onerror="this.src='https://q1.qlogo.cn/g?b=qq&nk=10001&s=100'" /></div>
          <div class="log-info">
            <div class="log-model">${item.model_name} <span style="font-size: 12px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; margin-left: 8px; font-weight: normal; color: #cbd5e1;">${item.token_name}</span></div>
            <div class="log-meta"><span>⏱️ ${time}</span><span>⚡ 耗时 ${item.use_time}s</span><span>📝 提示词 ${item.prompt_tokens} | 补全 ${item.completion_tokens}</span></div>
          </div>
          <div class="log-quota"><div class="quota-val">$${actualCost}</div><div class="quota-lbl">实际花费</div></div>
        </div>`;
      });
    }
    html += `</div></div></body></html>`;
    return html;
  }

  buildTextMsg(limit, used, remaining, logs) {
    let msg = `📊 中转站 API 状态报告\n`;
    msg += `=======================\n`;
    msg += `💰 总限额：$${limit.toFixed(2)}\n`;
    msg += `🔥 已消耗：$${used.toFixed(2)}\n`;
    msg += `🟢 剩余可用：$${remaining.toFixed(2)}\n\n`;

    if (logs && logs.length > 0) {
      msg += `📋 最近调用记录 (Top 5)：\n`;
      logs.forEach((item, index) => {
        let time = new Date(item.created_at * 1000).toLocaleString('zh-CN', { 
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        let actualCost = (item.quota / 500000).toFixed(6);

        msg += `\n${index + 1}️⃣ [${item.token_name || '未知'}] | 耗时: ${item.use_time}s`;
        msg += `\n🤖 模型: ${item.model_name}`;
        msg += `\n⏱️ 时间: ${time}`;
        msg += `\n🪙 花费: $${actualCost} (提示词 ${item.prompt_tokens} | 补全 ${item.completion_tokens})\n`;
      });
    } else {
      msg += `📋 暂无最近调用日志数据。`;
    }
    return msg;
  }

  async queryApi(e) {
    if (!e.isMaster) return e.reply(`哼唧，这是主人的专属面板，菲比不能随便给你看哦~ 🙅‍♀️`);

    let apiKey = API_KEY;
    if (!apiKey) {
      return await e.reply("⚠️ 尚未配置 API 密钥，请在插件顶部设置。");
    }

    await e.reply("正在抓取接口数据，请稍候...");

    try {
      let subRes = await this.fetchWithProxy(`${BALANCE_BASE_URL}/v1/dashboard/billing/subscription`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      let subData = await subRes.json();

      let now = new Date();
      let endDate = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate() + 1}`;
      let startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      let startStr = `${startDate.getFullYear()}-${startDate.getMonth() + 1}-${startDate.getDate()}`;

      let usageRes = await this.fetchWithProxy(`${BALANCE_BASE_URL}/v1/dashboard/billing/usage?start_date=${startStr}&end_date=${endDate}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      let usageData = await usageRes.json();

      let logRes = await this.fetchWithProxy(`${BALANCE_BASE_URL}/api/log/token?key=${apiKey}`);
      let logData = await logRes.json();

      let hardLimit = subData.hard_limit_usd || 0;
      let totalUsage = (usageData.total_usage || 0) / 100;
      let remaining = Math.max(0, hardLimit - totalUsage);

      let recentLogs = [];
      if (logData && logData.data && logData.data.length > 0) {
        let sortedLogs = logData.data.sort((a, b) => b.created_at - a.created_at);
        recentLogs = sortedLogs.slice(0, 5); 
      }

      let botUin = typeof Bot !== 'undefined' ? Bot.uin : (global.Bot ? global.Bot.uin : 10001);
      let htmlTemplate = this.buildHtml(hardLimit, totalUsage, remaining, recentLogs, botUin);
      
      let img = await this.generateImage(htmlTemplate, e, 'api_dashboard');
      
      if (img) {
        await e.reply(segment.image(img)); 
      } else {
        console.warn(`[API查询] 所有图片渲染均失败，已降级为纯文本输出。`);
        let textMsg = this.buildTextMsg(hardLimit, totalUsage, remaining, recentLogs);
        await e.reply(textMsg);
      }

    } catch (error) {
      console.error(`API额度查询失败: ${error}`);
      return await e.reply("❌ 查询失败，请检查网络连接、API 密钥或后台报错日志。");
    }
  }
}
