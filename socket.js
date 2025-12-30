const { io } = require('./server');
const socketAuth = require('./middleware/socketAuth');

io.use(socketAuth);

io.on('connection', (socket) => {
  // Frontend subscribes to vehicle
  socket.on('subscribe_vehicle', ({ vehicleId }) => {
    if (!vehicleId) return;

    // Optional RBAC check later
    socket.join(`vehicle:${vehicleId}`);
  });

  socket.on('disconnect', () => {
    // cleanup if needed
  });
});
