require('dotenv').config();
const { getAwsData } = require('../services/awsService');
const logger = require('../utils/logger');

const db = {
  query: async (type, params) => {
    const deviceId = params?.device_id || 'VCL001';
    try {
      const data = await getAwsData('/getData', deviceId);
      const filteredData = data.map(item => {
        const payload = item.payload || item;
        if (type === 'battery') {
          return {
            packState: payload.message202?.packState || 0,
            dcVoltage: payload.message412?.N_MCUDCVoltage || 0,
            current: payload.message412?.N_MotorACCurrent || 0,
          };
        } else if (type === 'motor') {
          return {
            motorSpeed: payload.message411?.N_motorSpeed || 0,
            motorTorque: payload.message411?.N_motorTorque || 0,
            mcuEnable: payload.message411?.St_MCU_enable || 0,
            acCurrent: payload.message412?.N_MotorACCurrent || 0,
            dcVoltage: payload.message412?.N_MCUDCVoltage || 0,
            motorTemp: payload.message412?.N_motorTemp || 0,
            mcuTemp: payload.message412?.N_MCUTemp || 0,
          };
        } else if (type === 'faults') {
          return payload.message413 || {};
        } else if (type === 'vehicle') {
          return payload;
        }
        throw new Error('Unsupported query type');
      });
      logger.info(`Queried ${type} data for ${deviceId}: ${filteredData.length} items`);
      return filteredData;
    } catch (err) {
      logger.error(`DB query error for ${type} (${deviceId}): ${err.message}`);
      throw err;
    }
  },

  queryHistorical: async (period, params) => {
    const deviceId = params?.device_id || 'VCL001';
    try {
      const data = await getAwsData('/getData', deviceId);
      const now = Date.now();
      let startTime;

      switch (period) {
        case 'today':
          startTime = now - 24 * 60 * 60 * 1000; // Last 24 hours
          break;
        case 'week':
          startTime = now - 7 * 24 * 60 * 60 * 1000; // Last 7 days
          break;
        case 'month':
          startTime = now - 30 * 24 * 60 * 60 * 1000; // Last 30 days
          break;
        case 'total':
          startTime = 0; // All data
          break;
        case 'recent':
          startTime = now - 10 * 60 * 1000; // Last 10 minutes
          break;
        default:
          throw new Error(`Invalid period: ${period}`);
      }

      // Sort data by timestamp
      const sortedData = data.sort((a, b) => {
        const timeA = new Date(a.time || now).getTime();
        const timeB = new Date(b.time || now).getTime();
        return timeA - timeB;
      });

      // Filter data by period
      const filteredData = sortedData.filter(item => {
        const timestamp = new Date(item.time || now).getTime();
        return timestamp >= startTime;
      });

      logger.info(`Filtered ${filteredData.length} items for ${deviceId} (${period})`);

      if (period === 'recent') {
        return filteredData.slice(-10).map(item => {
          const payload = item.payload || item;
          return {
            device_id: item.device_id || deviceId,
            timestamp: item.time || new Date().toISOString(),
            N_motorSpeed: payload.message411?.N_motorSpeed || 0,
            current: payload.message412?.N_MotorACCurrent || payload.message411?.N_motorTorque || 0,
            dcVoltage: payload.message412?.N_MCUDCVoltage || 0,
            packState: payload.message202?.packState || 0,
          };
        });
      }

      if (filteredData.length === 0) {
        logger.warn(`No data available for ${deviceId} (${period})`);
        return {
          runningHrs: 0,
          runningKms: 0,
          maxCurrent: 0,
          avgCurrent: 0,
          maxSpeed: 0,
          avgSpeed: 0,
          totalEnergy: 0,
          chargeCycles: 0,
          timestamp: now,
        };
      }

      // Aggregate metrics
      let runningHrs = 0;
      let runningKms = 0;
      let maxCurrent = 0;
      let currentSum = 0;
      let currentCount = 0;
      let maxSpeed = 0;
      let speedSum = 0;
      let speedCount = 0;
      let totalEnergy = 0;
      let chargeCycles = 0;
      let lastPackState = null;

      for (let i = 0; i < filteredData.length; i++) {
        const item = filteredData[i];
        const payload = item.payload || item;
        const motorSpeed = payload.message411?.N_motorSpeed || 0; // RPM (speed)
        const current = payload.message412?.N_MotorACCurrent || payload.message411?.N_motorTorque || 0; // Use torque as proxy
        const dcVoltage = payload.message412?.N_MCUDCVoltage || 0; // Volts
        const packState = payload.message202?.packState || 0; // Battery state

        // Time delta (seconds)
        const timeDelta = i > 0
          ? Math.max((new Date(item.time) - new Date(filteredData[i - 1].time)) / 1000, 0)
          : 5; // Default 5 seconds

        // Running hours
        if (motorSpeed > 0 && payload.message411?.St_MCU_enable === 1) {
          runningHrs += timeDelta / 3600; // Convert to hours
          speedSum += motorSpeed;
          speedCount++;
        }

        // Running Kms (RPM to km/h: placeholder factor 0.001885)
        if (motorSpeed > 0) {
          runningKms += (motorSpeed * 0.001885) * (timeDelta / 3600); // km/h * hours
        }

        // Speed (RPM to km/h)
        const speedKmH = motorSpeed * 0.001885 * 60;
        maxSpeed = Math.max(maxSpeed, speedKmH);

        // Current (use N_motorTorque as proxy if N_MotorACCurrent is 0)
        if (current !== 0) {
          maxCurrent = Math.max(maxCurrent, Math.abs(current));
          currentSum += current;
          currentCount++;
        }

        // Energy (kWh)
        if (current !== 0 && dcVoltage > 0) {
          totalEnergy += (Math.abs(current) * dcVoltage * timeDelta) / (1000 * 3600);
        }

        // Charge Cycles (estimate based on packState changes or time)
        if (lastPackState !== null && packState > lastPackState && packState >= 10) {
          chargeCycles += 1;
        } else if (payload.message411?.St_motorMode === 0 && motorSpeed === 0) {
          chargeCycles += timeDelta / (3600 * 4); // Assume 4-hour charge cycle when not running
        }
        lastPackState = packState;
      }

      // Averages
      const avgSpeed = speedCount > 0 ? (speedSum / speedCount) * 0.001885 * 60 : 0;
      const avgCurrent = currentCount > 0 ? currentSum / currentCount : 0;

      logger.info(`Aggregated for ${deviceId} (${period}): runningHrs=${runningHrs.toFixed(2)}, runningKms=${runningKms.toFixed(2)}, totalEnergy=${totalEnergy.toFixed(2)}, chargeCycles=${chargeCycles.toFixed(2)}`);

      return {
        runningHrs: Number(runningHrs.toFixed(1)),
        runningKms: Number(runningKms.toFixed(1)),
        maxCurrent: Math.round(maxCurrent),
        avgCurrent: Math.round(avgCurrent),
        maxSpeed: Math.round(maxSpeed),
        avgSpeed: Math.round(avgSpeed),
        totalEnergy: Number(totalEnergy.toFixed(1)),
        chargeCycles: Math.round(chargeCycles),
        timestamp: now,
      };
    } catch (err) {
      logger.error(`DB queryHistorical error for ${period} (${deviceId}): ${err.message}`);
      throw err;
    }
  },
};

db.on = (event, callback) => {
  if (event === 'connect') {
    callback();
    logger.info('Connected to AWS API');
  } else if (event === 'error') {
    callback(new Error('AWS API Error'));
    logger.error('AWS API Error:', err.message);
  }
};

module.exports = db;