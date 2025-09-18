const axios = require('axios');
const JSONStream = require('jsonstream');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');

const awsApi = axios.create({
  baseURL: process.env.AWS_API_BASE_URL,
  headers: { 'Authorization': `Bearer ${process.env.AWS_API_KEY || ''}` },
  timeout: 10000,
});

const getAwsData = async (endpoint, deviceId) => {
  const cacheKey = `getData:${deviceId}:${endpoint}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    logger.info(`Cache hit for ${cacheKey}`);
    return JSON.parse(cached);
  }

  try {
    const response = await awsApi.get(`/getData?deviceId=${deviceId}`, { responseType: 'stream' });
    const results = [];
    return new Promise((resolve, reject) => {
      response.data
        .pipe(JSONStream.parse('items.*'))
        .on('data', (item) => results.push(item.payload || item))
        .on('end', async () => {
          await redisClient.setEx(cacheKey, 30, JSON.stringify(results));
          logger.info(`Fetched and cached ${results.length} items for ${cacheKey}`);
          resolve(results);
        })
        .on('error', (err) => {
          logger.error(`Stream error for ${endpoint}:`, err.message);
          reject(err);
        });
    });
  } catch (err) {
    logger.error(`AWS API error for ${endpoint}:`, err.message);
    throw err;
  }
};

module.exports = { getAwsData };