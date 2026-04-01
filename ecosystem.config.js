require("dotenv").config({ path: require("path").join(__dirname, ".env") });

module.exports = {
    apps: [
        {
            name: "ns-bot",
            script: "bot.js",
            cwd: __dirname,
            exec_mode: "fork",
            node_args: "--dns-result-order=ipv4first",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",
            max_restarts: 10,
            min_uptime: "30s",
            restart_delay: 5000,
            kill_timeout: 5000,
            env: { NODE_ENV: "production" }
        },
        {
            name: "ns-webapp",
            script: "gui/server.js",
            args: "/home/ubuntu/asad-project/data/bot.db",
            cwd: __dirname,
            exec_mode: "fork",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "500M",
            env: {
                NODE_ENV: "production",
                PORT: "3333",
                GUI_AUTH_TOKEN: process.env.GUI_AUTH_TOKEN || ""
            }
        }
    ]
};
