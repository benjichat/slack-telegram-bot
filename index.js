// index.js

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const TelegramBot = require('node-telegram-bot-api');
const { db, verifyTablesExist } = require('./database');
const {
  cleanUpOldCodes,
  sendErrorToAdmin,
  handleSlackEvent,
  getSlackClientForTeam,
  setupTelegramBot,
  handleTelegramMessage,
  generateAndSendCode,
  openCreateBotModal,
  processBotTokenSubmission,
  getCustomBotForTeam,
  openSetupConnectionModal,
  processSetupConnectionSubmission
} = require('./helper-functions');

// Environment Variables
const {
  TELEGRAM_BOT_TOKEN, // Default Telegram bot token (TeleConnectBot)
  SLACK_SIGNING_SECRET,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  PORT,
  PUBLIC_URL,
} = process.env;

// Create Express App
const app = express();

// Middleware to capture raw body for Slack signature verification
app.use((req, res, next) => {
  if (req.headers['x-slack-signature']) {
    req.rawBody = '';
    req.on('data', (chunk) => {
      req.rawBody += chunk;
    });
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded bodies

// Map to store Telegram bots
const telegramBots = new Map(); // Map of telegram_bot_id to telegramBot instances

// Store default Telegram bot information
let defaultTelegramBotUsername = '';
let defaultTelegramBotId = null;
let defaultTelegramBot = null;

// Function to initialize the default Telegram bot (TeleConnectBot)
function initializeDefaultTelegramBot() {
  defaultTelegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

  defaultTelegramBot.getMe().then((botInfo) => {
    defaultTelegramBotUsername = botInfo.username;
    defaultTelegramBotId = botInfo.id.toString();

    // telegramBots.set(defaultTelegramBotId, defaultTelegramBot);

    // console.log(`${PUBLIC_URL}/bot/${defaultTelegramBotId}`)

    // // Set webhook for the default bot
    // // defaultTelegramBot.setWebHook(`${PUBLIC_URL}/bot/${defaultTelegramBotId}`);
    // defaultTelegramBot.setWebHook(`${PUBLIC_URL}/bot/${defaultTelegramBotId}`)
    // .then(() => {
    //   console.log(`Webhook set successfully for bot @${defaultTelegramBotUsername}`);
    // })
    // .catch((error) => {
    //   console.error(`Error setting webhook for bot @${defaultTelegramBotUsername}:`, error);
    // });

    // Create a route to receive updates for this bot
    app.post(`/bot/${defaultTelegramBotId}`, (req, res) => {
      console.log(`Received update for bot @${defaultTelegramBotUsername}`);
      defaultTelegramBot.processUpdate(req.body);
      res.sendStatus(200);
    });

    // Set up listeners for the bot
    defaultTelegramBot.on('message', (msg) => {
      handleTelegramMessage(msg, defaultTelegramBotId, defaultTelegramBot, telegramBots);
    });

  }).catch((error) => {
    console.error('Error initializing default Telegram bot:', error);
  });
}

// Initialize the default Telegram bot
initializeDefaultTelegramBot();

// Function to verify tables exist before starting the server
verifyTablesExist(db, async (missingTables) => {
  if (missingTables.length > 0) {
    const error = new Error(`Missing tables in the database: ${missingTables.join(', ')}`);
    console.error(error);
    await sendErrorToAdmin(error);
    process.exit(1); // Exit the application
  } else {
    // Load existing Telegram bots from database
    db.all('SELECT team_id, telegram_bot_token FROM team_bots', [], (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        sendErrorToAdmin(err);
      } else {
        rows.forEach((row) => {
          console.log(row.telegram_bot_token)
          setupTelegramBot(row.telegram_bot_token, row.team_id, app, telegramBots);
        });
      }
    });

    // Start the server
    app.listen(PORT, () => {
      console.log(`Express server is listening on port ${PORT}`);
    });

  }
});

// Route to handle Slack events
app.post('/bot/slack/events', async (req, res) => {
  try {
    const body = req.rawBody; // Raw body for signature verification
    const bodyObject = req.body;

    // Handle Slack URL verification challenge
    if (bodyObject.type === 'url_verification') {
      return res.status(200).send(bodyObject.challenge);
    }

    // Proceed with signature verification for other requests
    const slackSignature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];

    if (!slackSignature || !timestamp) {
      const error = new Error('Missing Slack signature or timestamp');
      await sendErrorToAdmin(error);
      return res.status(400).send('Missing Slack signature or timestamp');
    }

    const fiveMinutesAgo = ~~(Date.now() / 1000) - 300;

    if (timestamp < fiveMinutesAgo) {
      const error = new Error('Ignore stale request');
      await sendErrorToAdmin(error);
      return res.status(400).send('Ignore stale request');
    }

    const sigBasestring = 'v0:' + timestamp + ':' + body;
    const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET);
    hmac.update(sigBasestring, 'utf8');
    const mySignature = 'v0=' + hmac.digest('hex');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(mySignature, 'utf8'),
        Buffer.from(slackSignature, 'utf8')
      )
    ) {
      const error = new Error('Verification failed');
      await sendErrorToAdmin(error);
      return res.status(400).send('Verification failed');
    }

    const slackTeamId = bodyObject.team_id || (bodyObject.team && bodyObject.team.id);

    console.log(`Received event from Slack team ID: ${slackTeamId}`);

    getSlackClientForTeam(slackTeamId, async (err, client) => {
      if (err) {
        console.error('Error getting Slack client:', err);
        await sendErrorToAdmin(err);
        res.status(500).send('Internal Server Error');
        return;
      }

      // Use the client to handle the event
      const event = bodyObject.event;
      await handleSlackEvent(event, client, slackTeamId, telegramBots, defaultTelegramBotUsername, defaultTelegramBotId);
      res.status(200).send(); // Acknowledge the event
    });
  } catch (error) {
    console.error('Error in /bot/slack/events route:', error);
    await sendErrorToAdmin(error);
    res.status(500).send('Internal Server Error');
  }
});

// Route to handle Slack interactive actions
app.post('/bot/slack/actions', async (req, res) => {
  try {
    let payload;
    try {
      payload = JSON.parse(req.body.payload);
    } catch (error) {
      console.error('Error parsing payload:', error);
      await sendErrorToAdmin(error);
      return res.status(400).send('Invalid payload');
    }

    const action = payload.actions ? payload.actions[0] : null;
    const actionValue = action ? action.value : null;
    const actionId = action ? action.action_id : null;
    const teamId = payload.team.id;
    const userId = payload.user.id;
    const channelId = payload.channel ? payload.channel.id : null;

    getSlackClientForTeam(teamId, async (err, client) => {
      if (err) {
        console.error('Error getting Slack client:', err);
        await sendErrorToAdmin(err);
        return res.status(500).send('Internal Server Error');
      }

      if (payload.type === 'block_actions') {
        if (actionId === 'setup_connection') {
          // Open modal to set up the connection
          await openSetupConnectionModal(payload.trigger_id, client, channelId, teamId);
          res.status(200).send();
        } else if (actionId === 'add_connection') {
          await processSetupConnectionSubmission(payload, client, telegramBots);
          res.status(200).send();
        } else {
          res.status(200).send();
        }
      } else if (payload.type === 'view_submission' && payload.view.callback_id === 'setup_connection_submission') {
        // Handle modal submission
        await processSetupConnectionSubmission(payload, client, telegramBots);
        res.status(200).send();
      } else {
        res.status(200).send();
      }
    });
  } catch (error) {
    console.error('Error in /bot/slack/actions route:', error);
    await sendErrorToAdmin(error);
    res.status(500).send('Internal Server Error');
  }
});

// Route to handle Slack OAuth Redirect
app.get('/bot/slack/oauth_redirect', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    const error = new Error('Missing code parameter in OAuth redirect');
    console.error(error);
    await sendErrorToAdmin(error);
    res.status(400).send('Missing code parameter');
    return;
  }

  try {
    // Use a new WebClient instance without an access token
    const tempClient = new WebClient();

    const result = await tempClient.oauth.v2.access({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
    });

    if (!result.ok) {
      const error = new Error(`OAuth access error: ${result.error}`);
      console.error(error);
      await sendErrorToAdmin(error);
      res.status(500).send('OAuth access error');
      return;
    }

    // Store tokens and team information in the database
    const { team, access_token, bot_user_id } = result;

    db.run(
      `INSERT INTO slack_teams (team_id, team_name, access_token, bot_user_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET access_token=excluded.access_token, bot_user_id=excluded.bot_user_id`,
      [team.id, team.name, access_token, bot_user_id],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          sendErrorToAdmin(err);
          res.status(500).send('Internal Server Error');
        } else {
          res.send('App installed successfully!');
        }
      }
    );
  } catch (error) {
    console.error('OAuth error:', error);
    await sendErrorToAdmin(error);
    res.status(500).send('Internal Server Error');
  }
});

// Schedule cleanup every hour
setInterval(cleanUpOldCodes, 60 * 60 * 1000);

module.exports = {
  app,
  telegramBots,
  defaultTelegramBotUsername,
  defaultTelegramBotId,
  defaultTelegramBot,
};
