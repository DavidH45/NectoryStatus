const express = require('express');
const axios = require('axios');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const botVersion = require('./package.json');
const color = require('ansi-colors');
const parseDuration = require('parse-duration');
const ping = require('ping');
const net = require('net');
const dgram = require('dgram');
const { Webhook, MessageBuilder } = require('discord-webhook-node');

// Load the configuration file
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

const app = express();
const port = config.PageSettings.Port;

// Load services from the configuration file
const services = config.services.map(service => ({
  name: service.name,
  url: service.url,
  type: service.type,
  port: service.port || null,
  status: 'unknown',
  webhookURL: service.webhookURL || null,
  maintenance: service.maintenance || false,
  tooltip: service.tooltip || null
}));

const historyFilePath = path.join(__dirname, 'history.json');
const lastUpdatedFilePath = path.join(__dirname, 'lastUpdated.json');

// Ensure the history file is initialized if it doesn't exist or is empty
if (!fs.existsSync(historyFilePath) || fs.readFileSync(historyFilePath).length === 0) {
  fs.writeFileSync(historyFilePath, JSON.stringify({ services: [] }, null, 2));
}

// Ensure the lastUpdated file is initialized if it doesn't exist
if (!fs.existsSync(lastUpdatedFilePath) || fs.readFileSync(lastUpdatedFilePath).length === 0) {
  fs.writeFileSync(lastUpdatedFilePath, JSON.stringify({ lastUpdated: null }, null, 2));
}

async function sendDiscordNotification(webhookURL, title, description, color) {
  try {
    const hook = new Webhook(webhookURL);

    hook.setUsername(config.PageSettings.Name);
    hook.setAvatar(config.PageSettings.Logo);

    const embed = new MessageBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    // Send the embed
    await hook.send(embed);
  } catch (error) {
    console.error(`Failed to send Discord notification: ${error.message}`);
  }
}

function loadHistory() {
  let history = { services: [] };
  if (fs.existsSync(historyFilePath)) {
    const rawData = fs.readFileSync(historyFilePath);
    history = JSON.parse(rawData);
  }
  if (!Array.isArray(history.services)) {
    history.services = [];
  }
  return history;
}

function loadLastUpdated() {
  let lastUpdated = null;
  if (fs.existsSync(lastUpdatedFilePath)) {
    const rawData = fs.readFileSync(lastUpdatedFilePath);
    lastUpdated = JSON.parse(rawData).lastUpdated;
  }
  return lastUpdated;
}

function saveHistory(history) {
  fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2));
}

function saveLastUpdated(lastUpdated) {
  fs.writeFileSync(lastUpdatedFilePath, JSON.stringify({ lastUpdated }, null, 2));
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.floor(seconds)} seconds`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours} hour${hours > 1 ? 's' : ''}`;
  } else {
    const days = Math.floor(seconds / 86400);
    return `${days} day${days > 1 ? 's' : ''}`;
  }
}

async function logStatusChange(serviceName, status) {
  const timestamp = new Date().toISOString();
  let history = loadHistory();

  // Find or initialize service history
  let serviceHistory = history.services.find(s => s.name === serviceName);
  if (!serviceHistory) {
    serviceHistory = { name: serviceName, history: [] };
    history.services.push(serviceHistory);
  }

  const lastEntry = serviceHistory.history.length > 0 ? serviceHistory.history[serviceHistory.history.length - 1] : null;

  // Only record duration if the last status was 'offline' and the new status is 'online'
  if (lastEntry && lastEntry.status === 'offline' && status === 'online') {
    const lastTimestamp = new Date(lastEntry.timestamp);
    const currentTimestamp = new Date(timestamp);
    const duration = (currentTimestamp - lastTimestamp) / 1000; // duration in seconds
    lastEntry.duration = duration;
  }

  // Add new entry to history
  serviceHistory.history.push({ status, timestamp });

  saveHistory(history);
  saveLastUpdated(timestamp);

  // Console logging
  if(config.DebugMode) console.log(`${color.magenta.bold("[DEBUG]")}`+ ` Service: ${serviceName} | Status: ${status} | Timestamp: ${timestamp}`);

  // Send Discord notification if webhookURL is set
  const service = services.find(s => s.name === serviceName);
  if (service.webhookURL) {
    // Only send a notification if there is a status change (offline to online or vice versa)
    if (lastEntry && lastEntry.status !== status) {
      let description;
      const title = config.WebhookMessages[status === 'online' ? 'Online' : 'Offline'].Title;

      if (status === 'online' && lastEntry) {
        const formattedDuration = lastEntry.duration ? formatDuration(lastEntry.duration) : 'N/A';
        description = config.WebhookMessages.Online.Description
          .replace('{{serviceName}}', serviceName)
          .replace('{{lastOfflineTimestamp}}', Math.floor(new Date(lastEntry.timestamp).getTime() / 1000))
          .replace('{{currentTimestamp}}', Math.floor(new Date(timestamp).getTime() / 1000))
          .replace('{{formattedDuration}}', formattedDuration);
      } else if (status === 'offline') {
        description = config.WebhookMessages.Offline.Description
          .replace('{{serviceName}}', serviceName)
          .replace('{{currentTimestamp}}', Math.floor(new Date(timestamp).getTime() / 1000));
      }

      const color = status === 'online' ? config.StatusColors.Online : config.StatusColors.Offline; // Green for online, red for offline
      if(service.webhookURL) await sendDiscordNotification(service.webhookURL, title, description, color);
    }
  }
}

async function checkServiceStatus(service) {
  if (service.maintenance) {
    return 'maintenance';
  }

  try {
    if (service.type === 'website') {
      await axios.get(service.url);
      return 'online';
    } else if (service.type === 'minecraft') {
      const response = await axios.get(`https://api.mcstatus.io/v2/status/java/${service.url}`);
      if (!response.data.online) throw new Error('Minecraft server offline');
      return 'online';
    } else if (service.type === 'tcp') {
      const isOpen = await checkTcpPort(service.url, service.port);
      if (!isOpen) throw new Error('TCP port closed');
      return 'online';
    } else if (service.type === 'udp') {
      const isOpen = await checkUdpPort(service.url, service.port);
      if (!isOpen) throw new Error('UDP port closed');
      return 'online';
    } else if (service.type === 'ip') {
      return await checkIpStatus(service.url);
    }
  } catch (error) {
    let logMsg = `\n\n[${new Date().toLocaleString()}] [ERROR] Error checkServiceStatus function\n${error.stack}`;
    fs.appendFile("./logs.txt", logMsg, (e) => { 
      if(e && config.DebugMode) console.log(e);
    });
    return 'offline';
  }
}

async function checkIpStatus(ip) {
  try {
    const res = await ping.promise.probe(ip);
    if (res.alive) {
      return 'online';
    } else {
      throw new Error('Ping failed');
    }
  } catch (error) {
    let logMsg = `\n\n[${new Date().toLocaleString()}] [ERROR] Error checking IP, Trying external..\n${error.stack}`;
    fs.appendFile("./logs.txt", logMsg, (e) => { 
      if(e && config.DebugMode) console.log(e);
    });
    return e;
  }
}


async function checkTcpPort(host, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function checkUdpPort(host, port) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const message = Buffer.from('ping');
    client.send(message, 0, message.length, port, host, (err) => {
      if (err) {
        client.close();
        resolve(false);
      }
      client.close();
      resolve(true);
    });

    client.on('error', () => {
      client.close();
      resolve(false);
    });
  });
}

async function updateStatuses() {
  for (const service of services) {
    const newStatus = await checkServiceStatus(service);
    if (service.status !== newStatus) {
      service.status = newStatus;
      logStatusChange(service.name, newStatus);
    }
  }

  // Ensure lastUpdated is updated even if no status changes
  const timestamp = new Date().toISOString();
  saveLastUpdated(timestamp);
}

// Function to periodically save status to the JSON file if not 'offline'
async function periodicallySaveStatus() {
  let history = loadHistory();
  const timestamp = new Date().toISOString();

  for (const service of services) {
    const serviceHistory = history.services.find(s => s.name === service.name);

    if (serviceHistory) {
      const lastEntry = serviceHistory.history.length > 0 ? serviceHistory.history[serviceHistory.history.length - 1] : null;
      const status = lastEntry ? lastEntry.status : 'unknown';

      // Only save status if it's not 'offline'
      if (status !== 'offline') {
        // Append a new entry to the history
        serviceHistory.history.push({ status: service.status, timestamp });

        // Save the updated history
        saveHistory(history);
        if(config.DebugMode) console.log(`${color.magenta.bold("[DEBUG]")}`+ ` Status for ${service.name} saved at ${timestamp}`);
      }
    }
  }
}
updateStatuses();

const updateInterval = parseDuration(config.PageSettings.updateInterval);
setInterval(updateStatuses, updateInterval);

const saveInterval = 6 * 60 * 1000;
setInterval(periodicallySaveStatus, saveInterval);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static('public'));

function aggregateHistory(serviceHistory) {
  const historyByDay = {};

  serviceHistory.forEach(entry => {
    const date = new Date(entry.timestamp).toISOString().split('T')[0]; 
    if (!historyByDay[date]) {
      historyByDay[date] = { online: 0, offline: 0, durations: [], status: 'online' };
    }

    if (entry.status === 'offline') {
      historyByDay[date].offline++;
      historyByDay[date].status = 'offline';
      if (entry.duration) {
        historyByDay[date].durations.push(entry.duration);
      }
    } else {
      historyByDay[date].online++;
      if (historyByDay[date].status !== 'offline') {
        historyByDay[date].status = 'online';
      }
    }
  });

  return historyByDay;
}

function getLast90UniqueDays(historyByDay) {
  const uniqueDays = Object.keys(historyByDay).sort((a, b) => new Date(a) - new Date(b)).slice(0, 90);

  const result = uniqueDays.map(date => ({ date, ...historyByDay[date] }));

  // If there are less than 90 days, fill the rest with placeholders
  while (result.length < 90) {
    result.push({ date: 'N/A', status: 'placeholder', durations: [] });
  }

  return result;
}

app.get('/', async (req, res) => {
  let history = loadHistory();
  const lastUpdated = loadLastUpdated();

  const historyByService = services.map(service => {
    const serviceHistory = history.services.find(s => s.name === service.name)?.history || [];
    const historyByDay = aggregateHistory(serviceHistory);
    const last90Days = getLast90UniqueDays(historyByDay);
    const totalEntries = serviceHistory.length;
    const onlineEntries = serviceHistory.filter(entry => entry.status === 'online').length;
    const uptimePercentage = totalEntries ? (onlineEntries / totalEntries) * 100 : 0;

    return {
      name: service.name,
      status: service.status,
      history: last90Days,
      tooltip: service.tooltip,
      uptimePercentage: uptimePercentage.toFixed(2)
    };
  });

  // Determine the overall status
  let overallStatus = 'All services are online';
  let statusColor = config.StatusColors.Online;
  let statusIcon = 'fas fa-check-circle';
  let statusClass = 'online';
  const onlineServices = historyByService.filter(service => service.status === 'online').length;

  if (onlineServices === 0) {
    overallStatus = 'All services are offline';
    statusColor = config.StatusColors.Offline;
    statusIcon = 'fas fa-times-circle';
    statusClass = 'offline';
  } else if (onlineServices < services.length) {
    overallStatus = 'Partial services are offline';
    statusColor = config.StatusColors.PartialOffline;
    statusIcon = 'fas fa-exclamation-circle';
    statusClass = 'partial';
  }

  function getRelativeTime(date) {
    const currentDate = new Date();
    const targetDate = new Date(date);
    const timeDifference = currentDate.getTime() - targetDate.getTime();

    const seconds = Math.floor(timeDifference / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return days === 1 ? '1 day ago' : `${days} days ago`;
    } else if (hours > 0) {
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    } else if (minutes > 0) {
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    } else {
        return seconds <= 10 ? 'just now' : `${seconds} seconds ago`;
    }
  }

  res.render('index', { services: historyByService, lastUpdated, getRelativeTime, overallStatus, statusColor, statusIcon, statusClass, config });
});

app.get('/refresh', async (req, res) => {
  await updateStatuses();
  const lastUpdated = loadLastUpdated();

  res.json({ lastUpdated });
});




app.listen(port, async () => {
  console.log(`${color.blue.bold.underline(`Nectory Status v${botVersion.version} is now Online!`)}`);
  console.log(color.green.bold("[DASHBOARD] ") + `Web Server has started!`)

    try {
      const res = await ping.promise.probe('8.8.8.8');
      if (res.alive) {
        if(config.DebugMode) console.log(`${color.magenta.bold("[DEBUG]")}`+ ` Test ping to 8.8.8.8 successful.`);
      }
    } catch (error) {
      console.log(error)
      console.warn(
        color.red.bold('\n\n[WARNING] ') + 
        'Since you are hosting the application on pterodactyl, or similar and it does not have access to pinging We recommend hosting this on a VPS or Dedicated Server'
      );
    }

});


const filePath = './logs.txt';
const maxLength = 300;

async function handleAndUploadError(errorType, error) {
  console.log(error);

  const errorPrefix = `[${new Date().toLocaleString()}] [${errorType}] [v${packageFile.version}]`;
  const errorMsg = `\n\n${errorPrefix}\n${error.stack}`;
  fs.appendFile("./logs.txt", errorMsg, (e) => {
    if (e) console.log(e);
  });

  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading file:', err.message);
      return;
    }
  });
}

process.on('warn', async (error) => {
  handleAndUploadError('WARN', error);
});

process.on('error', async (error) => {
  handleAndUploadError('ERROR', error);
});

process.on('unhandledRejection', async (error) => {
  handleAndUploadError('unhandledRejection', error);
});

process.on('uncaughtException', async (error) => {
  handleAndUploadError('uncaughtException', error);
});