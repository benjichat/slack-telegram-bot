// helper-functions.js

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { db } = require('./database');
const { WebClient } = require('@slack/web-api');
const TelegramBot = require('node-telegram-bot-api');

// Environment Variables
const {
  PUBLIC_URL,
} = process.env;

// Example cleanup function
function cleanUpOldCodes() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  db.run(
    'DELETE FROM pending_mappings WHERE created_at < ?',
    [oneHourAgo],
    (err) => {
      if (err) {
        console.error('Database error during cleanup:', err);
      }
    }
  );
}

// Function to get Telegram chat info
function getTelegramChatInfos(slackChannelId, slackTeamId, callback) {
  db.all(
    'SELECT telegram_chat_id, telegram_bot_id FROM mappings WHERE slack_channel_id = ? AND slack_workspace_id = ?',
    [slackChannelId, slackTeamId],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        callback(err, null);
      } else {
        callback(null, rows);
      }
    }
  );
}

// Function to send errors to the admin via Telegram and store them
async function sendErrorToAdmin(error) {
  const errorMessage = `Error: ${error.message || error}`;
  console.error(errorMessage);

  // Store the error in the database
  const timestamp = new Date().toISOString();
  const stackTrace = error.stack || '';

  db.run(
    'INSERT INTO errors (timestamp, error_message, stack_trace) VALUES (?, ?, ?)',
    [timestamp, errorMessage, stackTrace],
    (err) => {
      if (err) {
        console.error('Database error while storing error:', err);
      }
    }
  );

}

// Function to get the bot user ID for a Slack team
function getBotUserIdForTeam(teamId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT bot_user_id FROM slack_teams WHERE team_id = ?',
      [teamId],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          reject(err);
        } else if (row) {
          resolve(row.bot_user_id);
        } else {
          const error = new Error('Team not found');
          console.error(error);
          reject(error);
        }
      }
    );
  });
}

// Function to check if a team has any custom bots
function teamHasCustomBot(teamId, callback) {
  db.get(
    'SELECT telegram_bot_username FROM team_bots WHERE team_id = ? AND telegram_bot_username IS NOT NULL LIMIT 1',
    [teamId],
    (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        const hasCustomBot = row ? row.telegram_bot_username : null;
        callback(null, hasCustomBot);
      }
    }
  );
}

// Function to get the custom bot for a team
function getCustomBotForTeam(teamId, callback) {
  db.get(
    'SELECT * FROM team_bots WHERE team_id = ? ORDER BY id DESC LIMIT 1',
    [teamId],
    (err, row) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, row);
      }
    }
  );
}

// Function to send interactive options message
async function sendInteractiveOptionsMessage(channelId, client, hasCustomBot) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Please click the button below to set up the connection between this Slack channel and Telegram:',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Set up connection',
            emoji: true,
          },
          value: 'setup_connection',
          action_id: 'setup_connection',
        },
      ],
    },
  ];

  const response = await client.chat.postMessage({
    channel: channelId,
    text: 'Please set up the connection:',
    blocks: blocks,
  });

  // Store the message timestamp in the database
  const messageTs = response.ts;

  db.run(
    `INSERT INTO channel_messages (channel_id, message_ts)
     VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET message_ts = excluded.message_ts`,
    [channelId, messageTs],
    (err) => {
      if (err) {
        console.error('Database error:', err);
      } else {
        console.log(`Stored message_ts for channel ${channelId}`);
      }
    }
  );
}

async function openSetupConnectionModal(triggerId, client, channelId, teamId) {
  getCustomBotForTeam(teamId, async (err, botInfo) => {
    if (err) {
      console.error('Error fetching custom bot info:', err);
      await sendErrorToAdmin(err);
    } else {
      const options = [
        {
          text: {
            type: 'plain_text',
            text: 'Connect TeleConnectBot',
            emoji: true,
          },
          value: JSON.stringify({ bot: 'teleconnectbot' }),
        },
      ];

      if (botInfo) {
        options.push({
          text: {
            type: 'plain_text',
            text: `Connect ${botInfo.telegram_bot_username}`,
            emoji: true,
          },
          value: JSON.stringify({ bot: 'custombot', bot_id: botInfo.telegram_bot_id }),
        });
      }

      const modalView = {
        type: 'modal',
        callback_id: 'setup_connection_submission',
        private_metadata: JSON.stringify({ channelId: channelId }),
        title: {
          type: 'plain_text',
          text: 'Set Up Connection',
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
        },
        submit: {
          type: 'plain_text',
          text: 'Submit',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'bot_selection',
            element: {
              type: 'static_select',
              action_id: 'bot_selected',
              placeholder: {
                type: 'plain_text',
                text: 'Select a bot to connect',
              },
              options: options,
            },
            label: {
              type: 'plain_text',
              text: 'Select Bot',
            },
          },
          {
            type: 'input',
            block_id: 'connection_type_selection',
            element: {
              type: 'static_select',
              action_id: 'connection_type_selected',
              placeholder: {
                type: 'plain_text',
                text: 'Select connection type',
              },
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Single Telegram channel',
                    emoji: true,
                  },
                  value: 'single',
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Multiple Telegram channels',
                    emoji: true,
                  },
                  value: 'multiple',
                },
              ],
            },
            label: {
              type: 'plain_text',
              text: 'Connection Type',
            },
          },
        ],
      };

      await client.views.open({
        trigger_id: triggerId,
        view: modalView,
      });
    }
  });
}

async function processSetupConnectionSubmission(payload, client, telegramBots) {
  const userId = payload.user.id;
  const teamId = payload.team.id;
  const stateValues = payload.view.state.values;
  const privateMetadata = JSON.parse(payload.view.private_metadata);
  const channelId = privateMetadata.channelId;

  const botSelectionBlock = stateValues['bot_selection']['bot_selected'];
  const botSelectionValue = JSON.parse(botSelectionBlock.selected_option.value);

  const connectionTypeBlock = stateValues['connection_type_selection']['connection_type_selected'];
  const connectionType = connectionTypeBlock.selected_option.value;

  let botInfo;
  if (botSelectionValue.bot === 'teleconnectbot') {
    botInfo = {
      telegram_bot_username: defaultTelegramBotUsername,
      telegram_bot_id: defaultTelegramBotId,
    };
  } else if (botSelectionValue.bot === 'custombot') {
    botInfo = await new Promise((resolve) => {
      getCustomBotForTeam(teamId, (err, info) => {
        if (err) {
          console.error('Error fetching custom bot info:', err);
          resolve(null);
        } else {
          resolve(info);
        }
      });
    });
    if (!botInfo) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No custom Telegram bot configured for this workspace. Please set up your Telegram bot first.',
      });
      return;
    }
  }

  // Store the connection type in the database
  return new Promise((resolve) => {
    setChannelConnectionType(channelId, teamId, connectionType, async (err) => {
      if (err) {
        console.error('Error setting connection type:', err);
        await sendErrorToAdmin(err);
        resolve();
      } else {
        // Generate and send the code
        await generateAndSendCode(channelId, userId, client, teamId, botInfo.telegram_bot_username, botInfo.telegram_bot_id);
        resolve();
      }
    });
  });
}

// Function to handle Slack events
async function handleSlackEvent(event, client, slackTeamId, telegramBots, defaultTelegramBotUsername, defaultTelegramBotId) {
  try {
    // Handle direct messages to the bot (e.g., for bot token submissions)
    if (event.type === 'message' && event.channel_type === 'im' && !event.bot_id) {
      await handleDirectMessage(event, client, telegramBots);
      return;
    }
    console.log(event)
    // Handle when the bot is added to a channel
    if (event.subtype === 'channel_join') {
      try {
        const botUserId = await getBotUserIdForTeam(slackTeamId);

        if (event.user === botUserId) {
          // Bot was added to a channel
          const channelId = event.channel;

          // Send interactive message with options
          await sendInteractiveOptionsMessage(channelId, client);
          return;
        }
      } catch (err) {
        console.error('Error getting bot user ID:', err);
        await sendErrorToAdmin(err);
        return;
      }
    }

    // Ignore messages from bots (including this bot)
    if (event.subtype === 'bot_message' || event.bot_id) {
      return;
    }

    // Ignore deleted messages
    if (event.subtype === 'message_deleted') {
      return;
    }

    const slackChannelId = event.channel;

    // Fetch all Telegram mappings for this Slack channel
    getTelegramChatInfos(slackChannelId, slackTeamId, async (err, mappings) => {
      if (err) {
        console.error('Error fetching Telegram chat infos:', err);
        await sendErrorToAdmin(err);
        return;
      }

      if (!mappings || mappings.length === 0) {
        // No mappings found
        return;
      }

      // Get the user's name
      let userName = 'Unknown User';
      if (event.user) {
        const userId = event.user;
        try {
          const userInfo = await client.users.info({ user: userId });

          if (userInfo.ok) {
            userName =
              userInfo.user.profile.display_name ||
              userInfo.user.real_name ||
              'Unknown';
          } else {
            console.error('Error in userInfo response:', userInfo.error);
            await sendErrorToAdmin(new Error(userInfo.error));
          }
        } catch (error) {
          console.error('Error fetching user info from Slack:', error);
          await sendErrorToAdmin(error);
        }
      } else if (event.username) {
        // For messages that include a username directly
        userName = event.username;
      } else {
        const error = new Error('No user ID or username found in the event');
        console.error(error);
        await sendErrorToAdmin(error);
      }

      // Prepare the message to send to Telegram
      function escapeHtml(text) {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      const escapedUserName = escapeHtml(userName);
      const escapedText = escapeHtml(event.text || '');
      const messageText = `<b>${escapedUserName}</b>: ${escapedText}`;

      // Get the connection type for this Slack channel
      getChannelConnectionType(slackChannelId, slackTeamId, async (err, connectionType) => {
        if (err) {
          console.error('Error getting connection type:', err);
          await sendErrorToAdmin(err);
          return;
        }

        // Send the message to each linked Telegram chat
        for (const mappingInfo of mappings) {
          const telegramChatId = mappingInfo.telegram_chat_id;
          const telegramBotId = mappingInfo.telegram_bot_id;

          const telegramBot = telegramBots.get(telegramBotId);

          if (!telegramBot) {
            console.error(`Telegram bot with ID ${telegramBotId} not found.`);
            await sendErrorToAdmin(new Error(`Telegram bot with ID ${telegramBotId} not found.`));
            continue;
          }

          try {
            // Send the message to Telegram
            await telegramBot.sendMessage(telegramChatId, messageText, { parse_mode: 'HTML' });
            console.log(`Message sent to Telegram chat ${telegramChatId}`);
          } catch (error) {
            console.error('Error sending message to Telegram:', error);
            await sendErrorToAdmin(error);
          }
        }
      });
    });
  } catch (error) {
    console.error('Error handling Slack event:', error);
    await sendErrorToAdmin(error);
  }
}

// Function to handle direct messages from users
async function handleDirectMessage(event, client, telegramBots) {
  const userId = event.user;
  const text = event.text.trim();
  const teamId = event.team;

  // Check if the user is submitting a bot token
  if (text.match(/^\d+:[A-Za-z0-9_-]{35}$/)) {
    // Validate the bot token
    try {
      const tempTelegramBot = new TelegramBot(text, { polling: false });
      const botInfo = await tempTelegramBot.getMe();
      const telegramBotUsername = botInfo.username;
      const telegramBotId = botInfo.id.toString();

      // Store the bot token and info in the database
      db.run(
        `INSERT INTO team_bots (team_id, telegram_bot_token, telegram_bot_username, telegram_bot_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, telegram_bot_id) DO UPDATE SET telegram_bot_token = excluded.telegram_bot_token`,
        [teamId, text, telegramBotUsername, telegramBotId],
        async (err) => {
          if (err) {
            console.error('Database error:', err);
            await sendErrorToAdmin(err);
            await client.chat.postMessage({
              channel: userId,
              text: 'An error occurred while saving your bot token. Please try again.',
            });
          } else {
            await client.chat.postMessage({
              channel: userId,
              text: `Successfully set up your Telegram bot @${telegramBotUsername}. Now you can connect your Slack channels to Telegram groups using this bot.`,
            });

            // Set up the Telegram bot
            setupTelegramBot(text, teamId, null, telegramBots);

            // Ask the user if they want to connect the new bot to a channel
            await promptConnectNewBotToChannel(userId, client);
          }
        }
      );
    } catch (error) {
      console.error('Error validating Telegram bot token:', error);
      await sendErrorToAdmin(error);
      await client.chat.postMessage({
        channel: userId,
        text: 'Invalid Telegram bot token. Please ensure you entered the correct token.',
      });
    }
  } else {
    // Handle other direct messages or provide help
    await client.chat.postMessage({
      channel: userId,
      text: 'Please provide a valid Telegram bot token to proceed.',
    });
  }
}

// Function to prompt user to submit their Telegram bot token via modal
async function openCreateBotModal(triggerId, client, channelId) {
  const modalView = {
    type: 'modal',
    callback_id: 'bot_token_submission',
    private_metadata: JSON.stringify({ channelId: channelId }), // Include channelId here
    title: {
      type: 'plain_text',
      text: 'Create New Custom Bot',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    submit: {
      type: 'plain_text',
      text: 'Submit',
    },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'To create a new Telegram bot, please follow these steps:\n\n1. Open Telegram and start a conversation with *@BotFather*.\n2. Send the command `/newbot` and follow the instructions to create a new bot.\n3. Once you have created the bot, you will receive a bot token.\n4. Paste the bot token below and click *Submit*.',
        },
      },
      {
        type: 'input',
        block_id: 'bot_token_input',
        element: {
          type: 'plain_text_input',
          action_id: 'bot_token',
          placeholder: {
            type: 'plain_text',
            text: 'Enter your Telegram bot token here',
          },
        },
        label: {
          type: 'plain_text',
          text: 'Telegram Bot Token',
        },
      },
    ],
  };

  response = await client.views.open({
    trigger_id: triggerId,
    view: modalView,
  });

}

// Function to process the bot token submission from the modal
function processBotTokenSubmission(payload, client, telegramBots) {
  console.log('below is the submission text');
  console.log(payload);

  const userId = payload.user.id;
  const teamId = payload.team.id;
  const botToken = payload.view.state.values.bot_token_input.bot_token.value.trim();
  const privateMetadata = JSON.parse(payload.view.private_metadata);
  const channelId = privateMetadata.channelId;

  // Validate the bot token format
  if (!botToken.match(/^\d+:[A-Za-z0-9_-]{35}$/)) {
    return {
      response_action: 'errors',
      errors: {
        bot_token_input: 'Invalid Telegram bot token format. Please try again.',
      },
    };
  }


  // Perform asynchronous operations after responding to Slack
  (async () => {
    try {
      // Validate the bot token with Telegram
      const tempTelegramBot = new TelegramBot(botToken, { polling: false });
      const botInfo = await tempTelegramBot.getMe();
      const telegramBotUsername = botInfo.username;
      const telegramBotId = botInfo.id.toString();

      // Store the bot token and info in the database
      db.run(
        `INSERT INTO team_bots (team_id, telegram_bot_token, telegram_bot_username, telegram_bot_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, telegram_bot_id) DO UPDATE SET telegram_bot_token = excluded.telegram_bot_token`,
        [teamId, botToken, telegramBotUsername, telegramBotId],
        async (err) => {
          if (err) {
            console.error('Database error:', err);
            await sendErrorToAdmin(err);
            await client.chat.postMessage({
              channel: userId,
              text: 'An error occurred while saving your bot token. Please try again.',
            });
          } else {
            console.log('Bot token saved successfully.');

            // Set up the Telegram bot
            setupTelegramBot(botToken, teamId, null, telegramBots);

            // Delete the initial message
            db.get(
              'SELECT message_ts FROM channel_messages WHERE channel_id = ?',
              [channelId],
              async (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  // Handle error
                } else if (row) {
                  const messageTs = row.message_ts;

                  try {
                    await client.chat.delete({
                      channel: channelId,
                      ts: messageTs,
                    });

                    // Send new message with options to add the bot to a group
                    await sendInteractiveOptionsMessage(channelId, client, telegramBotUsername);
                  } catch (error) {
                    console.error('Error deleting message:', error);
                    // Handle error
                  }
                } else {
                  // No message_ts found, handle accordingly
                }
              }
            );
          }
        }
      );
    } catch (error) {
      console.error('Error validating Telegram bot token:', error);
      await sendErrorToAdmin(error);
      await client.chat.postMessage({
        channel: userId,
        text: 'Invalid Telegram bot token. Please ensure you entered the correct token.',
      });
    }
  })();

  // return response;
}

// Function to prompt the user to connect the new bot to a Telegram group
async function promptConnectNewBotToChannel(userId, client) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Would you like to connect your new Telegram bot to a Slack channel now?',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Yes',
            emoji: true,
          },
          value: 'connect_new_bot_to_channel',
          action_id: 'connect_new_bot_to_channel',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'No',
            emoji: true,
          },
          value: 'do_not_connect',
          action_id: 'do_not_connect',
        },
      ],
    },
  ];

  await client.chat.postMessage({
    channel: userId,
    text: 'Connect to a Slack channel?',
    blocks: blocks,
  });
}

// Function to generate and send code
async function generateAndSendCode(channelId, userId, client, slackTeamId, telegramBotUsername, telegramBotId) {

  console.log("generating a new code")
  // Generate a unique code
  const code = uuidv4();

  // Store the code with the channel ID, user ID, team ID, and telegram_bot_id
  db.run(
    `INSERT INTO pending_mappings (code, slack_channel_id, slack_user_id, slack_workspace_id, telegram_bot_id)
    VALUES (?, ?, ?, ?, ?)`,
    [code, channelId, userId, slackTeamId, telegramBotId],
    async (err) => {
      if (err) {
        console.error('Database error:', err);
        await sendErrorToAdmin(err);
        await client.chat.postMessage({
          channel: channelId,
          text: 'An error occurred while generating the code. Please try again.',
        });
      } else {
        const message = `To connect this Slack channel with a Telegram group, please:

1. Add @${telegramBotUsername} to your Telegram group.
2. Send the following code to the Telegram group:

\`${code}\``;
        await client.chat.postMessage({
          channel: channelId,
          text: message,
        });

        console.log(`Generated code ${code} for Slack team ${slackTeamId}, channel ${channelId}`);
      }
    }
  );
}

// Function to forward Telegram messages to Slack
function forwardTelegramMessageToSlack(msg, telegramBotId, telegramBot, telegramBots) {
  console.log('---------------forwardTelegramMedssageToSlack---------------\n\n',msg)
  const telegramChatId = msg.chat.id.toString();
  const messageText = msg.text

  db.all(
    'SELECT slack_channel_id, slack_workspace_id FROM mappings WHERE telegram_chat_id = ? AND telegram_bot_id = ?',
    [telegramChatId, telegramBotId],
    async (err, rows) => {
      if (err) {
        console.error('Error fetching Slack channel IDs:', err);
        await sendErrorToAdmin(err);
        return;
      }

      if (rows.length === 0) {
        return; // No mapping found
      }

      for (const row of rows) {
        const slackChannelId = row.slack_channel_id;
        const slackTeamId = row.slack_workspace_id;

        getChannelConnectionType(slackChannelId, slackTeamId, async (err, connectionType) => {
          if (err) {
            console.error('Error getting connection type:', err);
            await sendErrorToAdmin(err);
            return;
          }

          getSlackClientForTeam(slackTeamId, async (err, client) => {
            if (err) {
              console.error('Error getting Slack client:', err);
              await sendErrorToAdmin(err);
              return;
            }

              // Proceed to send message to Slack
            const senderName = msg.from.first_name || 'Unknown';
            const username = msg.from.username || '';
            let messageText;

            if (msg.text) {
              messageText = `${msg.text}`;
            } else if (msg.photo) {
              messageText = 'sent a photo';
              // Handle photo sending here if needed
            } else {
              messageText = 'sent a message';
            }

            // Get user's profile photo
            let profilePhotoUrl = null;
            try {
              const userId = msg.from.id;
              const photos = await telegramBot.getUserProfilePhotos(userId, { limit: 1 });

              if (photos.total_count > 0) {
                // Get the largest photo
                const photoSizes = photos.photos[0];
                const largestPhoto = photoSizes[photoSizes.length - 1];
                const file = await telegramBot.getFile(largestPhoto.file_id);
                profilePhotoUrl = `https://api.telegram.org/file/bot${telegramBot.token}/${file.file_path}`;
              }
            } catch (error) {
              console.error('Error fetching user profile photo:', error);
              await sendErrorToAdmin(error);
            }

            // Proceed to send message to Slack
            let threadTs = null;

            if (connectionType === 'multiple') {
              // Get or create thread_ts for this Telegram chat and Slack channel
              db.get(
                'SELECT thread_ts FROM slack_threads WHERE slack_channel_id = ? AND telegram_chat_id = ?',
                [slackChannelId, telegramChatId],
                async (err, row) => {
                  if (err) {
                    console.error('Database error:', err);
                    await sendErrorToAdmin(err);
                    return;
                  } else {
                    if (row) {
                      threadTs = row.thread_ts;
                    }

                    // Send the message to Slack
                    let messageOptions = {
                      channel: slackChannelId,
                      text: messageText,
                      username: `${senderName} @${username}`,
                      icon_url: profilePhotoUrl,
                    };

                    if (threadTs) {
                      messageOptions.thread_ts = threadTs;
                    }

                    try {
                      const result = await client.chat.postMessage(messageOptions);
                      console.log(`Message sent to Slack channel ${slackChannelId}`);

                      if (!threadTs) {
                        // Save the thread_ts
                        threadTs = result.ts;

                        db.run(
                          `INSERT INTO slack_threads (slack_channel_id, telegram_chat_id, thread_ts)
                           VALUES (?, ?, ?)
                           ON CONFLICT(slack_channel_id, telegram_chat_id) DO UPDATE SET thread_ts=excluded.thread_ts`,
                          [slackChannelId, telegramChatId, threadTs],
                          (err) => {
                            if (err) {
                              console.error('Database error:', err);
                            }
                          }
                        );
                      }
                    } catch (error) {
                      console.error('Error sending message to Slack:', error);
                      await sendErrorToAdmin(error);
                    }
                  }
                }
              );
            } else {
              // For 'single' connection type, proceed as before
              try {
                await client.chat.postMessage({
                  channel: slackChannelId,
                  text: messageText,
                  username: `${senderName} @${username}`,
                  icon_url: profilePhotoUrl,
                });
                console.log(`Message sent to Slack channel ${slackChannelId}`);
              } catch (error) {
                console.error('Error sending message to Slack:', error);
                await sendErrorToAdmin(error);
              }
            }
          });
        });
      }
    }
  );
}

// Function to get Slack client for a specific team
function getSlackClientForTeam(teamId, callback) {
  db.get(
    'SELECT access_token FROM slack_teams WHERE team_id = ?',
    [teamId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        callback(err, null);
      } else if (row) {
        const client = new WebClient(row.access_token);
        callback(null, client);
      } else {
        const error = new Error('Team not found');
        console.error(error);
        callback(error, null);
      }
    }
  );
}

// Function to set up a Telegram bot
function setupTelegramBot(botToken, teamId, app = null, telegramBots) {
  const telegramBot = new TelegramBot(botToken, { polling: false });

  telegramBot.getMe().then(async (botInfo) => {
    const telegramBotUsername = botInfo.username;
    const telegramBotId = botInfo.id.toString();

    telegramBots.set(telegramBotId, telegramBot);

    // Store the bot info in the database, associated with the team
    db.run(
      `INSERT INTO team_bots (team_id, telegram_bot_token, telegram_bot_username, telegram_bot_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, telegram_bot_id) DO UPDATE SET telegram_bot_token = excluded.telegram_bot_token`,
      [teamId, botToken, telegramBotUsername, telegramBotId],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          sendErrorToAdmin(err);
        }
      }
    );

    console.log(`${PUBLIC_URL}/bot/${telegramBotId}`)

    // Set webhook for the bot
    telegramBot.setWebHook(`${PUBLIC_URL}/bot/${telegramBotId}`);

    // Create a route to receive updates for this bot
    if (app) {
      app.post(`/bot/${telegramBotId}`, (req, res) => {
        console.log(`Received update for bot @${telegramBotUsername}`);
        telegramBot.processUpdate(req.body);
        res.sendStatus(200);
      });
    }

    // Set up listeners for the bot
    telegramBot.on('message', (msg) => {
      console.log("something happeing in this")
      handleTelegramMessage(msg, telegramBotId, telegramBot, telegramBots);
    });

    console.log(`Telegram bot @${telegramBotUsername} set up successfully. 🚀`);
  }).catch((error) => {
    console.error('Error setting up Telegram bot:', error);
    sendErrorToAdmin(error);
  });
}

// Function to handle Telegram messages
function handleTelegramMessage(msg, telegramBotId, telegramBot, telegramBots) {
  const telegramChatId = msg.chat.id.toString();
  const telegramChatTitle = msg.chat.title ? msg.chat.title.toString() : 'Telegram Chat';

    // Check if the message indicates the bot was added to a group
    if (msg.new_chat_members) {
      const newMembers = msg.new_chat_members;
      const botWasAdded = newMembers.some((member) => member.id.toString() === telegramBotId);
  
      if (botWasAdded) {
        // The bot was added to the group
        // Send a message to the group asking the user to submit the code
        telegramBot.sendMessage(
          telegramChatId,
          'Hello! Please submit the code provided in Slack to connect this group with your Slack channel.'
        );
        return;
      }
    }

  if (msg.text) {
    const code = msg.text.trim();

    db.get(
      'SELECT * FROM pending_mappings WHERE code = ? AND telegram_bot_id = ?',
      [code, telegramBotId],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          sendErrorToAdmin(err);
          telegramBot.sendMessage(telegramChatId, 'An error occurred while fetching code from pending mappings');
        } else if (row) {
          console.log("row in pending mappings search", row)
          const slackChannelId = row.slack_channel_id;
          const slackTeamId = row.slack_workspace_id;

          // Get the connection_type from channel_settings
          getChannelConnectionType(slackChannelId, slackTeamId, (err, connectionType) => {
            if (err) {
              console.error('Error getting connection type:', err);
              sendErrorToAdmin(err);
              telegramBot.sendMessage(telegramChatId, 'An error occurred while processing your code.');
            } else {
              const mappingData = [telegramChatId, slackChannelId, slackTeamId, telegramBotId];
              console.log(connectionType)

              if (connectionType === 'single') {
                // For single connection, delete existing mappings and insert new one
                db.run(
                  'DELETE FROM mappings WHERE slack_channel_id = ? AND slack_workspace_id = ?',
                  [slackChannelId, slackTeamId],
                  (err) => {
                    if (err) {
                      console.error('Error deleting existing mappings:', err);
                      sendErrorToAdmin(err);
                      telegramBot.sendMessage(telegramChatId, 'An error occurred while updating the mapping.');
                    } else {
                      // Now insert the new mapping
                      const mappingSql = `INSERT INTO mappings (telegram_chat_id, slack_channel_id, slack_workspace_id, telegram_bot_id)
                        VALUES (?, ?, ?, ?)`;
                      db.run(
                        mappingSql,
                        mappingData,
                        async (err) => {
                          if (err) {
                            console.error('Database error in the mappingSql section:', err);
                            await sendErrorToAdmin(err);
                            telegramBot.sendMessage(telegramChatId, 'An error occurred while creating the mapping.');
                          } else {
                            // Success logic...
                            // Notify users, etc.
                          }
                        }
                      );
                    }
                  }
                );
              } else if (connectionType === 'multiple') {
                // For multiple connections, allow multiple mappings per Slack channel
                const mappingSql = `INSERT INTO mappings (telegram_chat_id, slack_channel_id, slack_workspace_id, telegram_bot_id)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(telegram_chat_id, slack_workspace_id, telegram_bot_id) DO UPDATE SET slack_channel_id=excluded.slack_channel_id`;
                db.run(
                  mappingSql,
                  mappingData,
                  async (err) => {
                    if (err) {
                      console.error('Database error in the mappingSql section:', err);
                      await sendErrorToAdmin(err);
                      telegramBot.sendMessage(telegramChatId, 'An error occurred while creating the mapping.');
                    } else {
                      // Success logic...
                      // Notify users, etc.
                    }
                  }
                );
              }
            }
          });

          // Delete the code from 'pending_mappings'
          db.run(
            'DELETE FROM pending_mappings WHERE code = ?',
            [code],
            (err) => {
              if (err) {
                console.error('Database error:', err);
                sendErrorToAdmin(err);
              }
            }
          );
        } else {
          // Not a code, proceed with existing message handling
          forwardTelegramMessageToSlack(msg, telegramBotId, telegramBot, telegramBots);
        }
      }
    );
  } else {
    // Existing message handling code
    forwardTelegramMessageToSlack(msg, telegramBotId, telegramBot, telegramBots);
  }
}

function setChannelConnectionType(slackChannelId, slackTeamId, connectionType, callback) {
  db.run(
    `INSERT INTO channel_settings (slack_channel_id, slack_workspace_id, connection_type)
     VALUES (?, ?, ?)
     ON CONFLICT(slack_channel_id, slack_workspace_id) DO UPDATE SET connection_type = excluded.connection_type`,
    [slackChannelId, slackTeamId, connectionType],
    (err) => {
      if (err) {
        console.error('Database error:', err);
        callback(err);
      } else {
        callback(null);
      }
    }
  );
}

function getChannelConnectionType(slackChannelId, slackTeamId, callback) {
  db.get(
    'SELECT connection_type FROM channel_settings WHERE slack_channel_id = ? AND slack_workspace_id = ?',
    [slackChannelId, slackTeamId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        callback(err, null);
      } else if (row) {
        callback(null, row.connection_type);
      } else {
        // Default to 'single' if not set
        callback(null, 'single');
      }
    }
  );
}

module.exports = {
  cleanUpOldCodes,
  sendErrorToAdmin,
  handleSlackEvent,
  handleDirectMessage,
  getSlackClientForTeam,
  setupTelegramBot,
  handleTelegramMessage,
  generateAndSendCode,
  openCreateBotModal,
  processBotTokenSubmission,
  getCustomBotForTeam,
  processSetupConnectionSubmission,
  openSetupConnectionModal
};
