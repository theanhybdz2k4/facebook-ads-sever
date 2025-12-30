// ecosystem.config.js
module.exports = {
  apps: [{
    name: "aams-app",
    script: "yarn",
    args: "dev",
    instances: "max",
    exec_mode: "cluster",
    watch: false,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "production"
    }
  }]
}

