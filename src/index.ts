import { Context, Hono } from 'hono';
import { z } from 'zod';
import { validator } from 'hono/validator';
import { ApplicationBindings, OpenAIRequest, OpenAIResponse, OpenAIStreamResponse } from './types';
import { SSEStreamingApi, streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import { generateConversationHash, getConversationId, saveConversationId } from './conversation';

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36",
  "Accept": "text/event-stream",
  "Accept-Language": "de,en-US;q=0.7,en;q=0.3",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://duckduckgo.com/?q=DuckDuckGo&ia=chat",
  "Content-Type": "application/json",
  "Origin": "https://duckduckgo.com",
  "Connection": "keep-alive",
  "Cookie": "dcm=1; bg=-1",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "Pragma": "no-cache",
  "TE": "trailers",
  "x-vqd-accept": "1",
  "cache-control": "no-store"
};

const statusURL = 'https://duckduckgo.com/duckchat/v1/status';
const chatURL = 'https://duckduckgo.com/duckchat/v1/chat';
const schema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string()
  })),
  stream: z.boolean().optional()
})


const models = [
  "gpt-3.5-turbo-0125",
  "claude-3-haiku-20240307",
  "meta-llama/Llama-3-70b-chat-hf",
  "mistralai/Mixtral-8x7B-Instruct-v0.1"
]

type AppContext = Context<{ Bindings: ApplicationBindings }>;
const app = new Hono()

// Handle CORS preflight request
app.use('/*', cors({
  origin: '*',
}));

/**
 * Fetches new x-vqd-4 conversation id from the status api header.
 * @returns {Promise<string | null>} The x-vqd-4 header value or null if not found.
 */
async function createNewConversationId(): Promise<string | null> {
  const res = await fetch(statusURL, {
    method: 'GET',
    headers: headers,
  });
  return res.headers.get('x-vqd-4');
}

/**
 * Handles the status route.
 * @param {Context} c The Hono context object.
 * @returns {Response} A response with the text 'Hi there!'.
 */
function handleStatusRoute(c: AppContext): Response {
  return c.text('Hi there!');
}

/**
 * Handles the /v1/models route.
 * @param {Context} c The Hono context object.
 * @returns {Response} A JSON response with the list of models.
 */
function handleModelsRoute(c: AppContext): Response {
  const list = models.map(model => ({
    id: model,
    object: 'model',
    created: 1686935002,
    owned_by: 'duckduckgo-ai',
  }));
  return c.json({
    object: 'list',
    data: list,
  });
}


// Validates the body of chat completions requests.
// @param {Context} c The Hono context object.
// @returns {OpenAIRequest | Response} The parsed OpenAI format request data or a 400 response if invalid.
const validateChatCompletionsRequest = validator('json', (value, c) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0].message }, 400);
  }
  return parsed.data;
});

/**
 * Handles the OpenAI format /v1/chat/completions route.
 * @param {Context} c The Hono context object.
 * @returns {Promise<Response>} A JSON response with the chat completion or an error response.
 */
async function handleChatCompletionsRoute(c: AppContext): Promise<Response | undefined> {
  // Try authorization if API_KEY was set
  const { API_KEY } = c.env;
  if (API_KEY) {
    const authorization = c.req.header('Authorization');
    if (!authorization || `Bearer ${API_KEY}` !== authorization) {
      return c.json({ error: 'Authorization required' }, 401);
    }
  }

  const params = await c.req.json<OpenAIRequest>();
  const requestParams = {
    model: params.model,
    messages: params.messages.map(({ role, content }) => ({ role: role === 'system' ? 'user' : role, content })),
  };
  const userMessages = requestParams.messages.map(m => m.content);

  // Provided in request or create a new one
  let conversationId: string | undefined;
  // Returned from DuckDuckGo response, used to continue conversation
  let newConversationId: string | undefined;

  try {
    conversationId = c.req.header('x-vqd-4');

    if (!conversationId) {
      // Strip the last user input and try restore the conversation id from the database by using conversation hash.
      const previousConversationHash = await generateConversationHash(userMessages.slice(0, userMessages.length - 1));
      const previousConversationId = await getConversationId(c.env.CONVERSATIONS, previousConversationHash);

      if (previousConversationId) {
        conversationId = previousConversationId;

        console.debug('Using cached conversation id: ', conversationId);
      } else {
        conversationId = await createNewConversationId() || '';
        console.debug('Created new conversation id: ', conversationId);
      }

      // API doesn not return new conversation id, we might been blocked
      if (!conversationId || conversationId === '') {
        return c.json({ error: 'Cannot obtain new x-xqd-4 and it was not provided nor cached' }, 503);
      }
    } else {
      console.debug('Using provided conversation id: ', conversationId);
    }

    const chatResponse = await fetch(chatURL, {
      method: 'POST',
      headers: { 'x-vqd-4': conversationId, ...headers },
      body: JSON.stringify(requestParams),
    });

    if (!chatResponse.ok) {
      return c.json({ error: 'Remote API error', message: await chatResponse.text() }, 503);
    }


    newConversationId = chatResponse.headers.get('x-vqd-4') ?? '';
    c.header('x-vqd-4', newConversationId);
    
    console.debug('New conversation id: ', newConversationId);

    // Stream response or normal response
    const isStream = params.stream;
    const aiResponse = chatResponse.body;

    if (isStream && aiResponse) {
      console.debug('Using stream API');
      return createStreamResponse(c, params.model, userMessages, newConversationId, aiResponse);
    } else if (aiResponse) {
      console.debug('Using normal API');
      return createNormalResponse(c, params.model, userMessages, newConversationId, aiResponse);
    } else {
      return c.json({ error: 'Unable to parse response' }, 500);
    }
  } catch (error) {
    console.error('Unknwon error:', error);
    return c.json({ error }, 500);
  }
}

async function createStreamResponse(c: AppContext, model: string, userMessages: string[], conversationId: string, aiResponse: ReadableStream<Uint8Array>) {
  let messagePars: string[] = [];

  // Inline function to handle stream responses and process conversation id
  async function handleStreamResponsePart(destinationStream: SSEStreamingApi, part: string, model: string) {
  
    try {
      const {action, role, message} = JSON.parse(part);
  
      const ddgAIResponse: OpenAIStreamResponse = {
        id: 'chatcmpl-duckduck-ai',
        object: 'chat.completion.chunk',
        created: Math.floor((new Date()).getTime() / 1000),
        model,
        system_fingerprint: 'fp_44709d6fcb',
        choices: [],
      };
  
      if (message) {
        ddgAIResponse.choices.push({
          index: 0,
          delta: {
            role,
            content: message,
          },
          finish_reason: null,
          content_filter_results: null,
        });

        // Save current message for next iteration to calculate conversation hash
        messagePars.push(message);
  
        await destinationStream.writeSSE({ data: JSON.stringify(ddgAIResponse) });
  
        return;
        
        /*
         * 2024/06/17 It seems the target is not standard OpenAI API.
         * Couldn't reproduce stream messages ends with [DONE], but object without a message field or empty message
         */
      } else if (
        part === '[DONE]' ||
        (action === 'success' && typeof message === 'undefined') ||
        (action === 'success' && message === '')
      ) {
        ddgAIResponse.choices.push({
          index: 0,
          finish_reason: 'stop',
          content_filter_results: null,
          delta: {},
        });
  
        // Combine user's message and last complete message to calculate conversation hash
        const conversationHash = await generateConversationHash([...userMessages, messagePars.join('')]);
        await saveConversationId(c.env.CONVERSATIONS, conversationHash, conversationId);

        console.debug('Saved conversation hash: ', conversationHash);

        await destinationStream.writeSSE({ data: JSON.stringify(ddgAIResponse) });
        // await destinationStream.writeSSE({ data: '[DONE]' });
      } else {
        throw new Error('Unknown stream response part');
      }
    } catch (error) {
      // TODO: Should this be handled?
      // console.debug('Response parse error', error);
    }
  }

  return streamSSE(c, async (stream) => {
    const reader = aiResponse.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';

        for (let part of parts) {
          part = part.substring(6);
          await handleStreamResponsePart(stream, part, model);
        }
      }
    } finally {
      reader.releaseLock();
    }
  });
}

async function createNormalResponse(c: AppContext, model: string, userMessage: string[], conversationId: string, aiResponse: ReadableStream<Uint8Array>): Promise<Response> {
  async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += new TextDecoder().decode(value);
      }
    } finally {
      reader.releaseLock();
    }
    return buffer;
  }

  const buffer = await readStream(aiResponse);
  const parts = buffer.split('\n');

  let responseContent = '';

  for (let part of parts) {
    part = part.substring(6);
    try {
      const parseJson = JSON.parse(part);
      if (parseJson['message']) {
        responseContent += parseJson['message'];
      }
    } catch {
      console.log('parse error');
    }
  }

  const openAIResponse: OpenAIResponse = {
    id: 'chatcmpl-duckduck-ai',
    object: 'chat.completion',
    created: (new Date()).getTime() / 1000,
    model,
    system_fingerprint: 'fp_44709d6fcb',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: responseContent,
        },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };


  const conversationHash = await generateConversationHash([...userMessage, responseContent]);
  await saveConversationId(c.env.CONVERSATIONS, conversationHash, conversationId);

  console.debug('Saved conversation hash: ', conversationHash)

  return c.json(openAIResponse);
}

// Register routes
app.get('/status', handleStatusRoute);
app.get('/v1/models', handleModelsRoute);
app.post('/v1/chat/completions', validateChatCompletionsRequest, handleChatCompletionsRoute);

export default app;