import { PassThrough } from "stream";
import _ from "lodash";
import axios, { AxiosResponse } from "axios";
import { Worker } from 'worker_threads';
import path from 'path';
import setCookie from 'set-cookie-parser';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import { DeepSeekHash } from "@/lib/challenge.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { CloudflareAuth } from '@/lib/cloudflare-auth.ts';

// 模型名称
const MODEL_NAME = "deepseek-chat";
// 插冷鸡WASM文件路径
const WASM_PATH = './sha3_wasm_bg.7b9ca65ddd.wasm';
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 3600;
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://chat.deepseek.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://chat.deepseek.com/",
  "Sec-Ch-Ua":
    '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "X-App-Version": "20241129.1"
};
const EVENT_COMMIT_ID = '41e9c7b1';
// 当前IP地址
let ipAddress = '';
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

// 添加 worker 池
const workerPool: (Worker & { inUse?: boolean })[] = [];
const MAX_WORKERS = 4; // 可以根据需要调整

const cloudflareAuth = new CloudflareAuth();

// Ajouter l'intercepteur pour toutes les réponses
axios.interceptors.response.use(
  (response) => {
    // Mise à jour des cookies sur réponse réussie
    if (response.headers['set-cookie']) {
      const newCookies = setCookie.parse(response.headers['set-cookie']);
      newCookies.forEach(cookie => {
        if (cookie.name === '__cf_bm') {
          cloudflareAuth.updateCookie(cookie.name, cookie.value);
          logger.debug('Updated Cloudflare cookie from response');
        }
      });
    }
    return response;
  },
  (error) => {
    // Mise à jour des cookies même en cas d'erreur
    if (error.response?.headers['set-cookie']) {
      const newCookies = setCookie.parse(error.response.headers['set-cookie']);
      newCookies.forEach(cookie => {
        if (cookie.name === '__cf_bm') {
          cloudflareAuth.updateCookie(cookie.name, cookie.value);
          logger.debug('Updated Cloudflare cookie from error response');
        }
      });
    }
    return Promise.reject(error);
  }
);

async function initCloudflareAuth() {
  try {
    await cloudflareAuth.init();
  } catch (error) {
    logger.error('Failed to initialize Cloudflare auth:', error);
    throw error; // Propager l'erreur au lieu de la capturer
  }
}

function getWorker() {
  // 从池中获取空闲worker或创建新worker
  let worker = workerPool.find(w => !w.inUse);
  if (!worker && workerPool.length < MAX_WORKERS) {
    worker = new Worker(path.join(path.resolve(), 'challenge-worker.js'));
    workerPool.push(worker);
  }
  if (worker) {
    worker.inUse = true;
  }
  return worker;
}

function releaseWorker(worker: (Worker & { inUse?: boolean })) {
  worker.inUse = false;
}

async function getIPAddress() {
  if (ipAddress) return ipAddress;
  
  // List of IP lookup services
  const ipServices = [
    'https://api.ipify.org?format=json',
    'https://api.ip.sb/ip',
    'https://api.myip.com',
    'https://ifconfig.me/ip'
  ];

  for (const service of ipServices) {
    try {
      const response = await axios.get(service, {
        timeout: 5000,
        headers: {
          'User-Agent': cloudflareAuth.getCookieString['User-Agent']
        }
      });

      let ip;
      if (typeof response.data === 'object') {
        // Handle JSON responses (like ipify)
        ip = response.data.ip;
      } else {
        // Handle plain text responses (like ifconfig.me)
        ip = response.data.trim();
      }

      if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
        logger.info(`Successfully got IP address from ${service}: ${ip}`);
        ipAddress = ip;
        return ip;
      }
    } catch (err) {
      logger.error(`Failed to get IP from ${service}:`, err.message);
      continue;
    }
  }

  // If all services fail, throw an error
  throw new APIException(EX.API_REQUEST_FAILED, 'Failed to get IP address from all services');
}

/**
 * 请求access_token
 *
 * 使用refresh_token去刷新获得access_token
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function requestToken(refreshToken: string) {
  if (accessTokenRequestQueueMap[refreshToken])
    return new Promise((resolve) =>
      accessTokenRequestQueueMap[refreshToken].push(resolve)
    );
  accessTokenRequestQueueMap[refreshToken] = [];
  logger.info(`Refresh token: ${refreshToken}`);
  const result = await (async () => {
    const result = await axios.get(
      "https://chat.deepseek.com/api/v0/users/current",
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...cloudflareAuth.getHeaders(),
          Cookie: cloudflareAuth.getCookieString()
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    const { token } = checkResult(result, refreshToken);
    return {
      accessToken: token,
      refreshToken: token,
      refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES,
    };
  })()
    .then((result) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(result)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      logger.success(`Refresh successful`);
      return result;
    })
    .catch((err) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(err)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return err;
    });
  if (_.isError(result)) throw result;
  return result;
}

/**
 * 获取缓存中的access_token
 *
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string): Promise<string> {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  return result.accessToken;
}

/**
 * 生成cookie
 */
// function cloudflareAuth.getCookieString() {
//   return `HWWAFSESTIME=${util.timestamp()}; HWWAFSESID=${util.generateRandomString({
//     charset: 'hex',
//     length: 18
//   })}; Hm_lvt_${util.uuid(false)}=${util.unixTimestamp()},${util.unixTimestamp()},${util.unixTimestamp()}; Hm_lpvt_${util.uuid(false)}=${util.unixTimestamp()}; _frid=${util.uuid(false)}; _fr_ssid=${util.uuid(false)}; _fr_pvid=${util.uuid(false)}`
// }

async function createSession(model: string, refreshToken: string): Promise<string> {
  const token = await acquireToken(refreshToken);
  const result = await axios.post(
    "https://chat.deepseek.com/api/v0/chat_session/create",
    {
      agent: "chat",
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...cloudflareAuth.getHeaders(),
        Cookie: cloudflareAuth.getCookieString()
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const { biz_data } = checkResult(result, refreshToken);
  if (!biz_data)
    throw new APIException(EX.API_REQUEST_FAILED, "创建会话失败，可能是账号或IP地址被封禁");
  return biz_data.id;
}

/**
 * 碰撞challenge答案
 * 
 * 厂商这个反逆向的策略不错哦
 * 相当于把计算量放在浏览器侧的话，用户分摊了这个计算量
 * 但是如果逆向在服务器上算，那这个成本都在服务器集中，并发一高就GG
 */
async function answerChallenge(response: any, targetPath: string): Promise<any> {
  const { algorithm, challenge, salt, difficulty, expire_at, signature } = response;
  const deepSeekHash = new DeepSeekHash();
  await deepSeekHash.init(WASM_PATH);
  const answer = deepSeekHash.calculateHash(algorithm, challenge, salt, difficulty, expire_at);
  return Buffer.from(JSON.stringify({
    algorithm,
    challenge,
    salt,
    answer,
    signature,
    target_path: targetPath
  })).toString('base64');
}

/**
 * 获取challenge响应
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function getChallengeResponse(refreshToken: string, targetPath: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.post('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    target_path: targetPath
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...cloudflareAuth.getHeaders(),
      Cookie: cloudflareAuth.getCookieString()
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  const { biz_data: { challenge } } = checkResult(result, refreshToken);
  return challenge;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  refConvId?: string,
  retryCount = 0
) {
  return (async () => {
    logger.info(messages);

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z\-]{36}@[0-9]+/.test(refConvId))
      refConvId = null;

    // 消息预处理
    const prompt = messagesPrepare(messages);

    // 解析引用对话ID
    const [refSessionId, refParentMsgId] = refConvId?.split('@') || [];

    // 创建会话
    const sessionId = refSessionId || await createSession(model, refreshToken);
    // 请求流
    const token = await acquireToken(refreshToken);

    const isSearchModel = model.includes('search') || prompt.includes('web search');
    const isThinkingModel = model.includes('think') || model.includes('reasoner') || model.includes('r1') || prompt.includes('deep thinking');

    if(isSearchModel && isThinkingModel)
      throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

    if (isThinkingModel) {
      const thinkingQuota = await getThinkingQuota(refreshToken);
      if (thinkingQuota <= 0) {
        throw new APIException(EX.API_REQUEST_FAILED, '深度思考配额不足');
      }
    }

    const challengeResponse = await getChallengeResponse(refreshToken, '/api/v0/chat/completion');
    const challenge = await answerChallenge(challengeResponse, '/api/v0/chat/completion');
    logger.info(`插冷鸡: ${challenge}`);

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        challenge_response: null,
        prompt,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...cloudflareAuth.getHeaders(),
          Cookie: cloudflareAuth.getCookieString(),
          'X-Ds-Pow-Response': challenge
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    // 发送事件，缓解被封号风险
    await sendEvents(sessionId, refreshToken);

    if (result.headers["content-type"].indexOf("text/event-stream") == -1) {
      result.data.on("data", buffer => logger.error(buffer.toString()));
      throw new APIException(
        EX.API_REQUEST_FAILED,
        `Stream response Content-Type invalid: ${result.headers["content-type"]}`
      );
    }

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(model, result.data, sessionId);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    return answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * Stream chat completion
 *
 * @param model Model name
 * @param messages Follow GPT series message format, provide full context for multi-turn dialogue
 * @param refreshToken refresh_token used to refresh access_token
 * @param refConvId Reference conversation ID
 * @param retryCount Retry count
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  refConvId?: string,
  retryCount = 0
) {
  return (async () => {
    logger.info("creating completion Stream")
    logger.info(messages);

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z\-]{36}@[0-9]+/.test(refConvId))
      refConvId = null;

    // 消息预处理
    const prompt = messagesPrepare(messages);

    // 解析引用对话ID
    const [refSessionId, refParentMsgId] = refConvId?.split('@') || [];

    const isSearchModel = model.includes('search') || prompt.includes('web search');
    const isThinkingModel = model.includes('think') || model.includes('reasoner') || model.includes('r1') || prompt.includes('deep thinking');

    if(isSearchModel && isThinkingModel)
      throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

    if (isThinkingModel) {
      const thinkingQuota = await getThinkingQuota(refreshToken);
      if (thinkingQuota <= 0) {
        throw new APIException(EX.API_REQUEST_FAILED, '深度思考配额不足');
      }
    }

    const challengeResponse = await getChallengeResponse(refreshToken, '/api/v0/chat/completion');
    const challenge = await answerChallenge(challengeResponse, '/api/v0/chat/completion');
    logger.info(`插冷鸡: ${challenge}`);

    // 创建会话
    const sessionId = refSessionId || await createSession(model, refreshToken);
    // 请求流
    const token = await acquireToken(refreshToken);

    const headers = {
      Authorization: `Bearer ${token}`,
      ...cloudflareAuth.getHeaders(),
      Cookie: cloudflareAuth.getCookieString(),
      'X-Ds-Pow-Response': challenge
    };

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        challenge_response: null,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers,
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    // Send events to mitigate the risk of account suspension
    await sendEvents(sessionId, refreshToken);

    if (result.headers["content-type"].indexOf("text/event-stream") == -1) {
      logger.error(
        `Invalid response Content-Type:`,
        result.headers["content-type"]
      );
      result.data.on("data", buffer => logger.error(buffer.toString()));
      const transStream = new PassThrough();
      transStream.end(
        `data: ${JSON.stringify({
          id: "",
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Service temporarily unavailable, third-party response error",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: util.unixTimestamp(),
        })}\n\n`
      );
      return transStream;
    }
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, result.data, sessionId, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    });
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          refConvId,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * Message preparation
 *
 * Since the API only takes the first message, this will merge multiple messages into one to achieve multi-turn dialogue effect
 *
 * @param messages Follow GPT series message format, provide full context for multi-turn dialogue
 */
function messagesPrepare(messages: any[]) {
  let content;
  if (messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\nPassthrough content:\n" + content);
  }
  else {
    content = (
      messages.reduce((content, message) => {
        if (_.isArray(message.content)) {
          return (
            message.content.reduce((_content, v) => {
              if (!_.isObject(v) || v["type"] != "text") return _content;
              return _content + (`${message.role}:` + v["text"] || "") + "\n";
            }, content)
          );
        }
        return (content += `${message.role}:${message.content}\n`);
      }, "") + "assistant:"
    )
      // 移除MD图像URL避免幻觉
      .replace(/\!\[.+\]\(.+\)/g, "");
    logger.info("\nMerged conversation:\n" + content);
  }
  return content;
}

/**
 * Check request result
 *
 * @param result Result
 * @param refreshToken refresh_token used to refresh access_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (!result.data) return null;
  const { code, data, msg } = result.data;
  if (!_.isFinite(code)) return result.data;
  if (code === 0) return data;
  if (code == 40003) accessTokenMap.delete(refreshToken);
  throw new APIException(EX.API_REQUEST_FAILED, `[Deepseek request failed]: ${msg}`);
}

/**
 * Receive complete message content from stream
 *
 * @param model Model name
 * @param stream Message stream
 */
async function receiveStream(model: string, stream: any, refConvId?: string): Promise<any> {
  let thinking = false;
  const isSearchModel = model.includes('search');
  const isThinkingModel = model.includes('think') || model.includes('reasoner') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`Model: ${model}, Thinking enabled: ${isThinkingModel}, Search enabled: ${isSearchModel}, Silent thinking: ${isSilentModel}, Fold thinking: ${isFoldModel}`);
  let refContent = '';
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event" || event.data.trim() == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!result.choices || !result.choices[0] || !result.choices[0].delta)
          return;
        if (!data.id)
          data.id = `${refConvId}@${result.message_id}`;
        if (result.choices[0].delta.type === "search_result" && !isSilentModel) {
          const searchResults = result.choices[0]?.delta?.search_results || [];
          refContent += searchResults.map(item => `Search result ${item.title} - ${item.url}`).join('\n') + '\n\n';
          return;
        }
        if (result.choices[0].delta.type === "thinking") {
          if (!thinking && isThinkingModel && !isSilentModel) {
            thinking = true;
            data.choices[0].message.content += isFoldModel ? "<details><summary>Thinking process</summary><pre>" : "[Thinking started]\n";
          }
          if (isSilentModel)
            return;
        }
        else if (thinking && isThinkingModel && !isSilentModel) {
          thinking = false;
          data.choices[0].message.content += isFoldModel ? "</pre></details>" : "\n\n[Thinking ended]\n";
        }
        if (result.choices[0].delta.content)
          data.choices[0].message.content += result.choices[0].delta.content;
        if (result.choices && result.choices[0] && result.choices[0].finish_reason === "stop") {
          data.choices[0].message.content = data.choices[0].message.content.replace(/^\n+/, '').replace(/\[citation:\d+\]/g, '') + (refContent ? `\n\n搜索结果来自：\n${refContent}` : '');
          resolve(data);
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(model: string, stream: any, refConvId: string, endCallback?: Function) {
  let thinking = false;
  const isSearchModel = model.includes('search');
  const isThinkingModel = model.includes('think') || model.includes('reasoner') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`Model: ${model}, Thinking enabled: ${isThinkingModel}, Search enabled: ${isSearchModel}, Silent thinking: ${isSilentModel}, Fold thinking: ${isFoldModel}`);
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event" || event.data.trim() == "[DONE]") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      if (!result.choices || !result.choices[0] || !result.choices[0].delta)
        return;
      result.model = model;
      if (result.choices[0].delta.type === "search_result" && !isSilentModel) {
        const searchResults = result.choices[0]?.delta?.search_results || [];
        if (searchResults.length > 0) {
          const refContent = searchResults.map(item => `Search result ${item.title} - ${item.url}`).join('\n') + '\n\n';
          transStream.write(`data: ${JSON.stringify({
            id: `${refConvId}@${result.message_id}`,
            model: result.model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: refContent },
                finish_reason: null,
              },
            ],
          })}\n\n`);
        }
        return;
      }
      if (result.choices[0].delta.type === "thinking") {
        if (!thinking && isThinkingModel && !isSilentModel) {
          thinking = true;
          transStream.write(`data: ${JSON.stringify({
            id: `${refConvId}@${result.message_id}`,
            model: result.model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: isFoldModel ? "<details><summary>Thinking process</summary><pre>" : "[Thinking started]\n" },
                finish_reason: null,
              },
            ],
            created,
          })}\n\n`);
        }
        if (isSilentModel)
          return;
      }
      else if (thinking && isThinkingModel && !isSilentModel) {
        thinking = false;
        transStream.write(`data: ${JSON.stringify({
          id: `${refConvId}@${result.message_id}`,
          model: result.model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: isFoldModel ? "</pre></details>" : "\n\n[Thinking ended]\n" },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`);
      }

      if (!result.choices[0].delta.content)
        return;

      transStream.write(`data: ${JSON.stringify({
        id: `${refConvId}@${result.message_id}`,
        model: result.model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: result.choices[0].delta.content.replace(/\[citation:\d+\]/g, '') },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`);
      if (result.choices && result.choices[0] && result.choices[0].finish_reason === "stop") {
        transStream.write(`data: ${JSON.stringify({
          id: `${refConvId}@${result.message_id}`,
          model: result.model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: "stop"
            },
          ],
          created,
        })}\n\n`);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        endCallback && endCallback();
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("data: [DONE]\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => {
      !transStream.closed && transStream.end("data: [DONE]\n\n");
      endCallback && endCallback();
    }
  );
  return transStream;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.get(
    "https://chat.deepseek.com/api/v0/users/current",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...cloudflareAuth.getHeaders(),
        Cookie: cloudflareAuth.getCookieString()
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  try {
    const { token } = checkResult(result, refreshToken);
    return !!token;
  }
  catch (err) {
    return false;
  }
}

async function sendEvents(refConvId: string, refreshToken: string) {
  try {
    const token = await acquireToken(refreshToken);
    const sessionId = `session_v0_${Math.random().toString(36).slice(2)}`;
    const timestamp = util.timestamp();
    const fakeDuration1 = Math.floor(Math.random() * 1000);
    const fakeDuration2 = Math.floor(Math.random() * 1000);
    const fakeDuration3 = Math.floor(Math.random() * 1000);
    const ipAddress = await getIPAddress();
    const response = await axios.post('https://chat.deepseek.com/api/v0/events', {
      "events": [
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp,
          "event_name": "__reportEvent",
          "event_message": "Calling event reporting interface",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "method": "post",
            "url": "/api/v0/events",
            "path": "/api/v0/events"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 100 + Math.floor(Math.random() * 1000),
          "event_name": "__reportEventOk",
          "event_message": "Successfully called event reporting interface",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "method": "post",
            "url": "/api/v0/events",
            "path": "/api/v0/events",
            "logId": util.uuid(),
            "metricDuration": Math.floor(Math.random() * 1000),
            "status": "200"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 200 + Math.floor(Math.random() * 1000),
          "event_name": "createSessionAndStartCompletion",
          "event_message": "Start creating conversation",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "__referrer": "",
            "agentId": "chat",
            "thinkingEnabled": false
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 300 + Math.floor(Math.random() * 1000),
          "event_name": "__httpRequest",
          "event_message": "httpRequest POST /api/v0/chat_session/create",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "__referrer": "",
            "url": "/api/v0/chat_session/create",
            "path": "/api/v0/chat_session/create",
            "method": "POST"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 400 + Math.floor(Math.random() * 1000),
          "event_name": "__httpResponse",
          "event_message": `httpResponse POST /api/v0/chat_session/create, ${Math.floor(Math.random() * 1000)}ms, reason: none`,
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat_session/create",
            "path": "/api/v0/chat_session/create",
            "method": "POST",
            "metricDuration": Math.floor(Math.random() * 1000),
            "status": "200",
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 500 + Math.floor(Math.random() * 1000),
          "event_name": "__log",
          "event_message": "Using buffer mode",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": ""
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 600 + Math.floor(Math.random() * 1000),
          "event_name": "chatCompletionApi",
          "event_message": "chatCompletionApi called",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "scene": "completion",
            "chatSessionId": refConvId,
            "withFile": "false",
            "thinkingEnabled": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 700 + Math.floor(Math.random() * 1000),
          "event_name": "__httpRequest",
          "event_message": "httpRequest POST /api/v0/chat/completion",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat/completion",
            "path": "/api/v0/chat/completion",
            "method": "POST"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 800 + Math.floor(Math.random() * 1000),
          "event_name": "completionFirstChunkReceived",
          "event_message": "Received first completion chunk (can be empty)",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "metricDuration": Math.floor(Math.random() * 1000),
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 900 + Math.floor(Math.random() * 1000),
          "event_name": "createSessionAndStartCompletion",
          "event_message": "Create session and start completion",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "agentId": "chat",
            "newSessionId": refConvId,
            "isCreateNewChat": "false",
            "thinkingEnabled": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1000 + Math.floor(Math.random() * 1000),
          "event_name": "routeChange",
          "event_message": `Route changed => /a/chat/s/${refConvId}`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "to": `/a/chat/s/${refConvId}`,
            "redirect": "false",
            "redirected": "false",
            "redirectReason": "",
            "redirectTo": "/",
            "hasToken": "true",
            "hasUserInfo": "true"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1100 + Math.floor(Math.random() * 1000),
          "event_name": "__pageVisit",
          "event_message": `访问页面 [/a/chat/s/${refConvId}] [0]：${fakeDuration1}ms`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "pathname": `/a/chat/s/${refConvId}`,
            "metricVisitIndex": 0,
            "metricDuration": fakeDuration1,
            "referrer": "none",
            "appTheme": "light"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1200 + Math.floor(Math.random() * 1000),
          "event_name": "__tti",
          "event_message": `/a/chat/s/${refConvId} TTI 上报：${fakeDuration2}ms`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "type": "warmStart",
            "referer": "",
            "metricDuration": fakeDuration2,
            "metricVisitIndex": 0,
            "metricDurationSinceMounted": 0,
            "hasError": "false"
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1300 + Math.floor(Math.random() * 1000),
          "event_name": "__httpResponse",
          "event_message": `httpResponse POST /api/v0/chat/completion, ${fakeDuration3}ms, reason: none`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "url": "/api/v0/chat/completion",
            "path": "/api/v0/chat/completion",
            "method": "POST",
            "metricDuration": fakeDuration3,
            "status": "200",
            "logId": util.uuid()
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 1400 + Math.floor(Math.floor(Math.random() * 1000)),
          "event_name": "completionApiOk",
          "event_message": "完成响应，响应有正常的的 finish reason",
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": cloudflareAuth.getCookieString["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": cloudflareAuth.getCookieString["User-Agent"],
            "__referrer": "",
            "condition": "hasDone",
            "streamClosed": false,
            "scene": "completion",
            "chatSessionId": refConvId
          },
          "level": "info"
        }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...cloudflareAuth.getHeaders(),
        Referer: `https://chat.deepseek.com/a/chat/s/${refConvId}`,
        Cookie: cloudflareAuth.getCookieString()
      },
      validateStatus: () => true,
    });
    checkResult(response, refreshToken);
    logger.info('Successfully sent events');
  }
  catch (err) {
    logger.error(err);
  }
}

/**
 * 获取深度思考配额
 */
async function getThinkingQuota(refreshToken: string) {
  try {
    const response = await axios.get('https://chat.deepseek.com/api/v0/users/feature_quota', {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        ...cloudflareAuth.getHeaders(),
        Cookie: cloudflareAuth.getCookieString()
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    const { biz_data } = checkResult(response, refreshToken);
    if (!biz_data) return 0;
    const { quota, used } = biz_data.thinking;
    if (!_.isFinite(quota) || !_.isFinite(used)) return 0;
    logger.info(`Thinking quota: ${quota}/${used}`);
    return quota - used;
  }
  catch (err) {
    logger.error('Failed to get thinking quota:', err);
    return 0;
  }
}

/**
 * 获取版本号
 */
async function fetchAppVersion(): Promise<string> {
  try {
    logger.info('Auto-getting version number');
    const response = await axios.get('https://chat.deepseek.com/version.txt', {
      timeout: 5000,
      validateStatus: () => true,
      headers: {
        ...cloudflareAuth.getHeaders(),
        Cookie: cloudflareAuth.getCookieString()
      }
    });
    if (response.status === 200 && response.data) {
      const version = response.data.toString().trim();
      logger.info(`Got version number: ${version}`);
      return version;
    }
  } catch (err) {
    logger.error('Failed to get version number:', err);
  }
  return "20241018.0";
}

function autoUpdateAppVersion() {
  fetchAppVersion().then((version) => {
    cloudflareAuth.getCookieString["X-App-Version"] = version;
  });
}

util.createCronJob('0 */10 * * * *', autoUpdateAppVersion).start();

// getIPAddress().then(() => {
//   autoUpdateAppVersion();
//   initCloudflareAuth();
// }).catch((err) => {
//   logger.error('获取 IP 地址失败:', err);
// });

// 在程序退出时清理workers
process.on('exit', async () => {
  workerPool.forEach(worker => worker.terminate());
});

export default {
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
  fetchAppVersion,
  initCloudflareAuth,
  getIPAddress,
  autoUpdateAppVersion
};
