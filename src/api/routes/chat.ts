import _ from 'lodash';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';

export default {
  prefix: "/yyds/v1/chat",

  post: {
    '/completions': async (request: Request) => {
      request
        .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
        .validate('body.messages', _.isArray)
        .validate('headers.authorization', _.isString);
      // token切分
      const tokens = chat.tokenSplit(request.headers.authorization);
      // 随机挑选一个token
      const token = _.sample(tokens);
      let { model, messages, stream } = request.body;
      if (['deepseek_chat', 'deepseek_code', 'deepseek-chat*', 'deepseek-chat', 'deepseek-coder'].includes(model)) {
        model = {
          'deepseek-chat*': 'deepseek_chat',
          'deepseek-chat': 'deepseek_chat',
          'deepseek-coder': 'deepseek_code'
        }[model] || model;
      } else {
        model = 'deepseek_chat';
      }
      if (stream) {
        const stream = await chat.createCompletionStream(model, messages, token);
        return new Response(stream, {
          type: "text/event-stream"
        });
      } else {
        return await chat.createCompletion(model, messages, token);
      }
    }
  }
};
