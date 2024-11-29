import { PassThrough } from "stream";
import _ from "lodash";
import AsyncLock from "async-lock";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

// 模型名称
const MODEL_NAME = "deepseek-chat";
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
  "X-App-Version": "20241018.0",
};
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};

// 聊天异步锁
const chatLock = new AsyncLock();

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
function generateCookie() {
  return `intercom-HWWAFSESTIME=${util.timestamp()}; HWWAFSESID=${util.generateRandomString({
    charset: 'hex',
    length: 18
  })}; Hm_lvt_${util.uuid(false)}=${util.unixTimestamp()},${util.unixTimestamp()},${util.unixTimestamp()}; Hm_lpvt_${util.uuid(false)}=${util.unixTimestamp()}; _frid=${util.uuid(false)}; _fr_ssid=${util.uuid(false)}; _fr_pvid=${util.uuid(false)}`
}

/**
 * 清除上下文
 *
 * @param model 模型名称
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function clearContext(model: string, refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.post(
    "https://chat.deepseek.com/api/v0/chat/clear_context",
    {
      model_class: model,
      append_welcome_message: false
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
  checkResult(result, refreshToken);
}

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
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  const { biz_data } = checkResult(result, refreshToken);
  return biz_data.id;
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

    const result = await axios.post(
      "https://chat.deepseek.com/api/v0/chat/completion",
      {
        chat_session_id: sessionId,
        parent_message_id: refParentMsgId || null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: (model.includes('think') || model.includes('r1') || prompt.includes('深度思考')) ? true : false
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie()
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

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
        thinking_enabled: (model.includes('think') || model.includes('r1') || prompt.includes('深度思考')) ? true : false
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie()
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

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
    logger.info("\n透传内容：\n" + content);
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
    logger.info("\n对话合并：\n" + content);
  }
  return content;
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
  const isThinkingModel = model.includes('think') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`模型: ${model}, 是否思考: ${isThinkingModel}, 是否静默思考: ${isSilentModel}, 是否折叠思考: ${isFoldModel}`);
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
        if (!result.choices || !result.choices[0] || !result.choices[0].delta || !result.choices[0].delta.content)
          return;
        if (!data.id)
          data.id = `${refConvId}@${result.message_id}`;
        if (result.choices[0].delta.type === "thinking") {
          if (!thinking && isThinkingModel && !isSilentModel) {
            thinking = true;
            data.choices[0].message.content += isFoldModel ? "<details><summary>思考过程</summary><pre>" : "[思考开始]";
          }
          if (isSilentModel)
            return;
        }
        else if (thinking && isThinkingModel && !isSilentModel) {
          thinking = false;
          data.choices[0].message.content += isFoldModel ? "</pre></details>" : "[思考结束]";
        }
        data.choices[0].message.content += result.choices[0].delta.content;
        if (result.choices && result.choices[0] && result.choices[0].finish_reason === "stop") {
          data.choices[0].message.content = data.choices[0].message.content.replace(/^\n+/, '');
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
  const isThinkingModel = model.includes('think') || model.includes('r1');
  const isSilentModel = model.includes('silent');
  const isFoldModel = model.includes('fold');
  logger.info(`模型: ${model}, 是否思考: ${isThinkingModel}, 是否静默思考: ${isSilentModel}, 是否折叠思考: ${isFoldModel}`);
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
      if (!result.choices || !result.choices[0] || !result.choices[0].delta || !result.choices[0].delta.content)
        return;
      result.model = model;
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
                delta: { role: "assistant", content: isFoldModel ? "<details><summary>思考过程</summary><pre>" : "[思考开始]" },
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
              delta: { role: "assistant", content: isFoldModel ? "</pre></details>" : "[思考结束]" },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`);
      }

      transStream.write(`data: ${JSON.stringify({
        id: `${refConvId}@${result.message_id}`,
        model: result.model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: result.choices[0].delta.content },
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
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
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

export default {
  createCompletion,
  createCompletionStream,
  getTokenLiveStatus,
  tokenSplit,
};
