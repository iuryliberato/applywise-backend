// server.js
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const app = express();
const mongoose = require('mongoose');
const cors = require('cors');
const logger = require('morgan');
const path = require('path');  

const testJwtRouter = require('./controllers/test-jwt');
const authRouter = require('./controllers/auth');
const profileRouter = require('./controllers/profile');
const jobApplicationsRouter = require('./controllers/jobApplications');

const PORT = process.env.PORT || 3000;


mongoose.connect(process.env.MONGODB_URI);

mongoose.connection.on('connected', () => {
  console.log(`Connected to MongoDB ${mongoose.connection.name}.`);
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(logger('dev'));


app.use(express.static(path.join(__dirname, 'dist')));

app.use('/test-jwt', testJwtRouter);
app.use('/auth', authRouter);
app.use('/profile', profileRouter);
app.use('/job-applications', jobApplicationsRouter);

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


app.listen(PORT, () => {
  console.log(`connected to port ${PORT}`);
});

module.exports = app;
