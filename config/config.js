const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const configDir = __dirname; // Point to config folder
const configs = {};

try {
  if (fs.existsSync(configDir)) {
    fs.readdirSync(configDir).forEach(file => {
      if (file.endsWith('.json') && file !== 'config.js') {
        const deviceId = file.replace('.json', '').toLowerCase();
        try {
          configs[deviceId] = JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8'));
          logger.info(`Loaded config for device: ${deviceId}`);
        } catch (err) {
          logger.error(`Failed to parse config file ${file}:`, err.message);
        }
      }
    });
  } else {
    logger.error(`Config directory not found: ${configDir}`);
  }
} catch (err) {
  logger.error(`Error reading config directory ${configDir}:`, err.message);
}

module.exports = { 
  getConfig: (deviceId) => {
    const normalizedDeviceId = deviceId.toLowerCase();
    if (!configs[normalizedDeviceId] && !configs['vcl001']) {
      logger.warn(`No config found for deviceId ${normalizedDeviceId}, and default VCL001 config missing`);
      return null;
    }
    return configs[normalizedDeviceId] || configs['vcl001'];
  }
};