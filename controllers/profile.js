// routes/profile.js
const express = require('express');
const verifyToken = require('../middleware/verify-token');
const Profile = require('../models/profile');

const router = express.Router();

// GET /profile/me  → get current user's profile
router.get('/my-profile', verifyToken, async (req, res) => {
  const profile = await Profile.findOne({ user: req.user._id });
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(profile);
});

// POST /profile/me  → create or update profile for logged in user
router.post('/my-profile', verifyToken, async (req, res) => {
  const {
    fullName,
    headline,
    location,
    summary,
    primarySkills,
    yearsOfExperience,
    links,
    cvUrl,
  } = req.body;

  // upsert: create if doesn't exist, update if it does
  const profile = await Profile.findOneAndUpdate(
    { user: req.user._id },
    {
      user: req.user._id,
      fullName,
      headline,
      location,
      summary,
      primarySkills,
      yearsOfExperience,
      links,
      cvUrl,
    },
    { new: true, upsert: true }
  );

  res.json(profile);
});

module.exports = router;
