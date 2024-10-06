// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'slack-telegram-bot',
      script: 'index.js',
      env: {
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
        SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
        SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
        PORT: process.env.PORT || 3000,
        PUBLIC_URL: process.env.PUBLIC_URL,
      },
    },
  ],
};
