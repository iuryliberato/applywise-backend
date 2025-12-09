const express = require('express');
const verifyToken = require('../middleware/verify-token');
const Profile = require('../models/profile');

const pdfParse = require('pdf-parse');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const openai = require('../config/openai');

const router = express.Router();

router.get('/my-profile', verifyToken, async (req, res) => {
  const profile = await Profile.findOne({ user: req.user._id });
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }
  res.json(profile);
});

router.post('/my-profile', verifyToken, async (req, res) => {
  const {
    fullName,
    headline,
    location,
    summary,
    primarySkills,
    projects,
    yearsOfExperience,
    interests,
    links,
    cvUrl,
    experience,
    education,
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
      projects,
      yearsOfExperience,
      interests,
      links,
      cvUrl,
      experience,
      education,
    },
    { new: true, upsert: true }
  );

  res.json(profile);
});

router.put('/my-profile', verifyToken, async (req, res) => {
  try {
    const profile = await Profile.findOneAndUpdate(
      { user: req.user._id },
      {
        user: req.user._id,
        fullName: req.body.fullName,
        headline: req.body.headline,
        location: req.body.location,
        summary: req.body.summary,
        primarySkills: req.body.primarySkills,
        projects: req.body.projects,
        yearsOfExperience: req.body.yearsOfExperience,
        interests: req.body.interests,
        links: req.body.links,
        cvUrl: req.body.cvUrl,
        experience: req.body.experience,
        education: req.body.education,
      },
      { new: true, upsert: true }
    );

    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ err: 'Failed to save profile' });
  }
});


router.post(
  '/my-profile/cv',
  verifyToken,
  upload.single('cv'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No CV file uploaded' });
      }

      if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Only PDF CVs are supported for now' });
      }

      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer);
      const cvText = pdfData.text;

      fs.unlink(req.file.path, () => {});

      const prompt = `
      From the following CV text, extract and return ONLY JSON in this exact shape:
      {
        "fullName": "",
        "headline": "",
        "summary": "",
        "location": "",
        "primarySkills": [],
        "yearsOfExperience": 0,
        "projects": [
          "name": "",
          "tech": ",
          "description": "",
       ],
        "interests": [],
        "links": {
          "linkedin": "",
          "github": "",
          "portfolio": ""
        },
        "experience": [
          {
            "jobTitle": "",
            "company": "",
            "location": "",
            "startDate": "",
            "endDate": "",
            "description": ""
          }
        ],
        "education": [
          {
            "institution": "",
            "degree": "",
            "fieldOfStudy": "",
            "startDate": "",
            "endDate": ""
          }
        ]
      }

      CV TEXT:
      ${cvText}
      `;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
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

      let extracted;
      try {
        extracted = JSON.parse(raw);
      } catch (err) {
        return res.status(500).json({ error: 'Failed to parse AI response as JSON' });
      }

      const profile = await Profile.findOneAndUpdate(
        { user: req.user._id },
        {
          user: req.user._id,
          fullName: extracted.fullName || undefined,
          headline: extracted.headline || undefined,
          summary: extracted.summary || undefined,
          location: extracted.location || undefined,
          primarySkills: extracted.primarySkills || [],
          projects: extracted.projects || [],
          yearsOfExperience: extracted.yearsOfExperience || 0,
          links: extracted.links || {},
          interests: extracted.interests || [],
          experience: extracted.experience || [],
          education: extracted.education || [],
        },
        { new: true, upsert: true }
      );

      return res.json(profile);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to process CV' });
    }
  }
);

module.exports = router;
