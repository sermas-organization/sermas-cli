import { Command, Option } from 'commander';
import mqtt from 'mqtt';
import { CommandParams } from '../../libs/dto/cli.dto';
import { DialogueAgentMessageDto } from '../../libs/dto/dialogue.dto';
import logger from '../../libs/logger';
import { fail, sleep, uuid, waitInterrupt } from '../../libs/util';

const languages = ['es-ES', 'pt-PT', 'it-IT', 'de-DE', 'en-GB', 'fr-FR'];
const defaultLanguage = 'en-GB';
const defaultLLM = 'chatgpt';

export default {
  setup: async (command: Command) => {
    command
      .description('Chat with an agent')
      .argument(
        '[appId]',
        `Reference to an application or the selected one will be used`,
      )
      .argument('[sessionId]', `A session ID to reuse or a new one is created`)
      .addOption(
        new Option(
          '-l, --language [language]',
          'Language used in the format `en-US`',
        )
          .default(defaultLanguage)
          .choices(languages),
      )
      .addOption(
        new Option(
          '-g, --gender [gender]',
          'Gender of the avatar (used by TTS)',
        )
          .default('F')
          .choices(['F', 'M', 'X']),
      )
      .addOption(
        new Option('-m, --llm [llm]', 'LLM model to use').default(defaultLLM),
      );
  },

  run: async ({ args, config, feature, flags, api }: CommandParams) => {
    let [appId, sessionId] = args;
    const { llm, language, gender } = flags;

    if (!appId) {
      appId = config.currentApp;
    }

    if (!sessionId) {
      sessionId = uuid();
    }

    if (!appId) {
      return fail(
        `Missing appId, select an application or provide it as argument.`,
      );
    }

    const credentials = await api.loadAppCredentials(appId);
    if (credentials === null) {
      return fail(`Failed to get access token for ${appId}`);
    }

    const res = await api.saveClientCredentials(appId, credentials);
    if (res === null)
      return fail(`Failed to save client credentials for appId=${appId}`);

    let client: mqtt.MqttClient;
    try {
      client = await api.connectMqtt(appId);
    } catch (e) {
      return fail(`[${appId}] MQTT error: ${e.stack}`);
    }

    const messages: DialogueAgentMessageDto[] = [];

    client.subscribe(`app/${appId}/dialogue/messages`);
    client.on('message', (topic, payload) => {
      try {
        const message = JSON.parse(
          payload.toString(),
        ) as DialogueAgentMessageDto;
        messages.push(message);
      } catch (e: any) {
        logger.warn(`Failed to parse message: ${e.stack}`);
      }
    });

    const showAnswer = () => {
      if (messages.length === 0) return;

      const fullMessage = messages
        .sort((m1, m2) => (+m1.chunkId > +m2.chunkId ? 1 : -1))
        .reduce((text, message) => `${text} ${message.text}`, '');

      messages.splice(0, messages.length);

      logger.info(`[agent] ${fullMessage}`);
    };

    const waitAnswer = async () => {
      logger.debug(`Waiting for response...`);

      const maxSleep = 5;
      let sleepedTime = 0;
      let lastMessage = messages.length;
      let waitMore = true;
      while (waitMore) {
        await sleep(1000);

        const received = messages.length !== lastMessage;
        if (received) {
          sleepedTime = 0;
          showAnswer();
          continue;
        }
        waitMore = sleepedTime < maxSleep;
        sleepedTime++;
        lastMessage = messages.length;
      }
      showAnswer();
    };

    const sendChat = async (message: string) => {
      const res = await appApi.sendChatMessage({
        message,
        appId,
        sessionId,
        gender: gender ? (gender === 'X' ? 'F' : gender) : 'F',
        language: language || defaultLanguage,
        llm: llm || defaultLLM,
      });
      if (res === null) return fail();
      logger.info(`[you] ${message}`);
    };

    let quit = false;
    waitInterrupt().then(() => (quit = true));

    const appApi = await api.getAppClient(appId);

    while (!quit) {
      const answers = await feature.prompt([
        {
          name: 'message',
          message: 'Your message',
          type: 'input',
        },
      ]);

      if (answers.message && answers.message.length > 0) {
        await sendChat(answers.message);
      }

      await waitAnswer();
    }
  },
};
