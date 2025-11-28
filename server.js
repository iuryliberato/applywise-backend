// server.js
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
const logger = require('morgan');

const testJwtRouter = require('./controllers/test-jwt');
const authRouter = require('./controllers/auth');
const profileRouter = require('./controllers/profile');
const jobApplicationsRouter = require('./controllers/jobApplications');

mongoose.connect(process.env.MONGODB_URI);

mongoose.connection.on('connected', () => {
  console.log(`Connected to MongoDB ${mongoose.connection.name}.`);
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(logger('dev'));

// Routes go here
app.get('/', (req, res) => {
  res.json({ ok: true, path: req.path });
});
app.use('/test-jwt', testJwtRouter);
app.use('/auth', authRouter);
app.use('/profile', profileRouter);
app.use('/job-applications', jobApplicationsRouter);

app.listen(3000, () => {
  console.log("connected to port 3000")
} )

module.exports = app;
