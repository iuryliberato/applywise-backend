// routes/profile.js
const express = require('express');
const verifyToken = require('../middleware/verify-token');
const Profile = require('../models/profile');

// AI: pdf-parse + OpenAI
const pdfParse = require('pdf-parse');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const openai = require('../config/openai');

const router = express.Router();

// GET /profile/my-profile  → get current user's profile
router.get('/my-profile', verifyToken, async (req, res) => {
  const profile = await Profile.findOne({ user: req.user._id });
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(profile);
});

// POST /profile/my-profile  → create or update profile for logged in user
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

// POST /profile/my-profile/cv → upload CV, parse, and update profile
router.post(
  '/my-profile/cv',
  verifyToken,
  upload.single('cv'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No CV file uploaded' });
      }

      console.log('CV ROUTE HIT, file:', req.file.originalname, req.file.mimetype);

      if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Only PDF CVs are supported for now' });
      }

      // 1) Read and parse PDF into text
      console.log('🔍 Reading PDF...');
      const dataBuffer = fs.readFileSync(req.file.path);

      console.log('🔍 Calling pdfParse... (type is:', typeof pdfParse, ')');
      const pdfData = await pdfParse(dataBuffer);
      const cvText = pdfData.text;
      

      fs.unlink(req.file.path, () => {});

      console.log('📄 Extracted CV text length:', cvText.length);

      // 2) Build AI prompt
      const prompt = `
      From the following CV text, extract and return ONLY JSON in this exact shape:
      
      {
        "fullName": "",
        "headline": "",
        "summary": "",
        "location": "",
        "primarySkills": [],
        "yearsOfExperience": 0,
        "links": {
          "linkedin": "",
          "github": "",
          "portfolio": ""
        }
      }
      
      CV TEXT:
      ${cvText}
      `;

      console.log('🤖 Calling OpenAI...');

// 👇 Use Chat Completions instead of Responses API
const completion = await openai.chat.completions.create({
  model: 'gpt-4o-mini', // or 'gpt-4.1-mini' if you prefer
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content:
        'You are a helpful assistant that extracts structured data from CV text and returns ONLY valid JSON.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ],
});
const raw = completion.choices[0].message.content;
console.log('RAW AI OUTPUT:', raw);

let extracted;
try {
  extracted = JSON.parse(raw);
} catch (err) {
  console.error('Failed to parse AI JSON:', err);
  return res
    .status(500)
    .json({ error: 'Failed to parse AI response as JSON' });
}

// 3) Upsert profile
const profile = await Profile.findOneAndUpdate(
  { user: req.user._id },
  {
    user: req.user._id,
    fullName: extracted.fullName || undefined,
    headline: extracted.headline || undefined,
    summary: extracted.summary || undefined,
    location: extracted.location || undefined,
    primarySkills: extracted.primarySkills || [],
    yearsOfExperience: extracted.yearsOfExperience || 0,
    links: extracted.links || {},
  },
  { new: true, upsert: true }
);
      return res.json(profile);
    } catch (err) {
      console.error('CV parsing error:', err);
      return res.status(500).json({ error: 'Failed to process CV' });
    }
  }
);

module.exports = router;
