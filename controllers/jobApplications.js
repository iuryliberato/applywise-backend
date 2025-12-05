const express = require('express');
const verifyToken = require('../middleware/verify-token');
const JobApplication = require('../models/jobApplication');
const openai = require('../config/openai');
const mongoose = require('mongoose');
const Profile = require('../models/profile');
const { normalizeJobUrl } = require('../utils/normalizeJobUrl');



const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const SCRAPER_BASE_URL = 'https://api.scraperapi.com';

function buildScraperUrl(targetUrl) {
  const urlObj = new URL(targetUrl);

  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url: targetUrl,
    // you can also add render=true if you want JS rendering:
    // render: 'true',
  });

  const host = urlObj.hostname;

  // Protected domains that need premium mode
  if (host.includes('indeed.com') || host.includes('linkedin.com')) {
    params.set('premium', 'true');        // or 'ultra_premium' if your plan allows
  }

  return `${SCRAPER_BASE_URL}?${params.toString()}`;
}




const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const router = express.Router();

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
router.post('/from-link', verifyToken, async (req, res) => {
  try {
    const { jobUrl, status: incomingStatus } = req.body;

    if (!jobUrl) {
      return res.status(400).json({ error: 'jobUrl is required' });
    }

    const ALLOWED_STATUSES = [
      'Idea',
      'Applied',
      'Interviewing',
      'Tech-Test',
      'Offer',
      'Rejected',
    ];

    const normalizedStatus = ALLOWED_STATUSES.includes(incomingStatus)
      ? incomingStatus
      : 'Idea';

    if (!SCRAPER_API_KEY) {
      console.error('SCRAPER_API_KEY is missing');
      return res
        .status(500)
        .json({ error: 'Server misconfigured: missing Scraper API key' });
    }

    const finalJobUrl = normalizeJobUrl(jobUrl);
    console.log('Original jobUrl:', jobUrl);
    console.log('Final normalized jobUrl:', finalJobUrl);

    const scraperUrl = buildScraperUrl(finalJobUrl);
    console.log(
      'Calling ScraperAPI:',
      scraperUrl.replace(SCRAPER_API_KEY, '***') // hide key in logs
    );

    const response = await fetch(scraperUrl, {
      redirect: 'follow',
    });

    const httpStatus = response.status;
    const body = await response.text(); // read body once
    if (!response.ok) {
      console.error(
        'ScraperAPI error:',
        httpStatus,
        body.slice(0, 500)
      );
    
      let message = `Failed to fetch job URL via scraping API (status ${httpStatus})`;
    
      if (body.includes('Protected domains may require adding premium=true')) {
        message =
          'This job website requires a premium scraping mode. Try a different source (e.g. company careers page) or paste the job details manually.';
      }
    
      return res.status(502).json({
        error: message,
        upstreamStatus: httpStatus,
      });
    }
    

    const html = body;
    const text = stripHtml(html);
    const textForAi = text.slice(0, 12000);

    const prompt = `
You will receive the text content of a job posting page.
Extract and return ONLY JSON in the following shape:

{
  "jobTitle": "",
  "companyName": "",
  "location": "",
  "employmentType": "",
  "seniorityLevel": "",
  "summary": "",
  "responsibilities": [],
  "requirements": [],
  "niceToHave": [],
  "perksAndBenefits": [],
  "salaryInfo": "",
  "source": ""
}

JOB PAGE TEXT:
${textForAi}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an assistant that extracts structured job data from messy web page text. Return ONLY JSON.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const raw = completion.choices[0].message.content;

    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse AI JSON:', raw);
      return res
        .status(500)
        .json({ error: 'Failed to parse AI response as JSON' });
    }

    const jobApp = await JobApplication.create({
      user: req.user._id,
      jobUrl,
      source: extracted.source || undefined,
      jobTitle: extracted.jobTitle || undefined,
      companyName: extracted.companyName || undefined,
      location: extracted.location || undefined,
      employmentType: extracted.employmentType || undefined,
      seniorityLevel: extracted.seniorityLevel || undefined,
      summary: extracted.summary || undefined,
      responsibilities: extracted.responsibilities || [],
      requirements: extracted.requirements || [],
      niceToHave: extracted.niceToHave || [],
      perksAndBenefits: extracted.perksAndBenefits || [],
      salaryInfo: extracted.salaryInfo || undefined,
      rawTextSnippet: textForAi.slice(0, 5000),
      status: normalizedStatus,
    });

    return res.status(201).json(jobApp);
  } catch (err) {
    console.error('Error in /job-applications/from-link:', err);
    return res.status(500).json({ error: 'Failed to process job link' });
  }
});

router.post('/', verifyToken, async (req, res) => {
  try {
    const {
      jobTitle,
      companyName,
      location,
      employmentType,
      seniorityLevel,
      summary,
      responsibilities,
      requirements,
      niceToHave,
      perksAndBenefits,
      salaryInfo,
      status,
      source,
    } = req.body;

    const job = await JobApplication.create({
      user: req.user._id,
      jobTitle,
      companyName,
      location,
      employmentType,
      seniorityLevel,
      summary,
      responsibilities: responsibilities || [],
      requirements: requirements || [],
      niceToHave: niceToHave || [],
      perksAndBenefits: perksAndBenefits || [],
      salaryInfo,
      status,
      source: source || 'Manual',
    });

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create application' });
  }
});

router.get('/my-applications', verifyToken, async (req, res) => {
  try {
    const { status } = req.query;

    const ALLOWED_STATUSES = [
      'Idea',
      'Applied',
      'Interviewing',
      'Tech-Test',
      'Offer',
      'Rejected',
    ];

    const query = { user: req.user._id };

    if (status && ALLOWED_STATUSES.includes(status)) {
      query.status = status;
    }

    const apps = await JobApplication.find(query).sort({ updatedAt: -1 });

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

router.get('/:id', verifyToken, async (req, res) => {
  try {
    const app = await JobApplication.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!app) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(app);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

router.patch('/:id/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;

    const ALLOWED_STATUSES = [
      'Idea',
      'Applied',
      'Interviewing',
      'Tech-Test',
      'Offer',
      'Rejected',
    ];

    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const updated = await JobApplication.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { status },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

router.get('/my-applications/summary', verifyToken, async (req, res) => {
  try {
    const userId = mongoose.Types.ObjectId.createFromHexString(req.user._id);

    const pipeline = [
      { $match: { user: userId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ];

    const raw = await JobApplication.aggregate(pipeline);

    const ALLOWED_STATUSES = [
      'Idea',
      'Applied',
      'Interviewing',
      'Tech-Test',
      'Offer',
      'Rejected',
    ];

    const summary = {};
    ALLOWED_STATUSES.forEach((s) => {
      summary[s] = 0;
    });

    raw.forEach((row) => {
      if (row._id && summary.hasOwnProperty(row._id)) {
        summary[row._id] = row.count;
      }
    });

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

router.get('/my-applications/recent', verifyToken, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;

    const apps = await JobApplication.find({ user: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(limit);

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recent applications' });
  }
});

router.post('/:id/cover-letter', verifyToken, async (req, res) => {
  try {
    const job = await JobApplication.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!job) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const profile = await Profile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(400).json({ error: 'You need to create a profile first' });
    }

    const profileText = `
Name: ${profile.fullName || ''}
Headline: ${profile.headline || ''}
Location: ${profile.location || ''}
Summary: ${profile.summary || ''}
Experience: ${profile.experience || ''}
Education: ${profile.education || ''}
Primary skills: ${(profile.primarySkills || []).join(', ')}
Years of experience: ${profile.yearsOfExperience ?? 'N/A'}
Links:
- LinkedIn: ${profile.links?.linkedin || ''}
- GitHub: ${profile.links?.github || ''}
- Portfolio: ${profile.links?.portfolio || ''}
`.trim();

    const jobText = `
Job title: ${job.jobTitle || ''}
Company: ${job.companyName || ''}
Location: ${job.location || ''}
Employment type: ${job.employmentType || ''}
Seniority: ${job.seniorityLevel || ''}
Summary:
${job.summary || ''}
Responsibilities:
- ${(job.responsibilities || []).join('\n- ')}
Requirements:
- ${(job.requirements || []).join('\n- ')}
Nice to have:
- ${(job.niceToHave || []).join('\n- ')}
Perks & benefits:
- ${(job.perksAndBenefits || []).join('\n- ')}
`.trim();

    const prompt = `
You are an assistant helping a software engineer write job applications.
Using the CANDIDATE PROFILE and JOB DESCRIPTION below, write a tailored, concise cover letter in clear UK English.
Guidelines:
- Start with a short, friendly intro.
- Mention the role and company by name.
- Highlight 3–4 of the most relevant skills and experiences from the candidate that match the job.
- Keep it to about 3–5 paragraphs, max 450–500 words.
CANDIDATE PROFILE:
${profileText}
JOB DESCRIPTION:
${jobText}
`;

    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const coverLetterText =
      response.output_text ??
      response.output?.[0]?.content?.[0]?.text ??
      '';

    if (!coverLetterText) {
      return res.status(500).json({ error: 'AI did not return any text' });
    }

    job.coverLetter = coverLetterText;
    await job.save();

    return res.json({
      coverLetter: job.coverLetter,
      job,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate cover letter' });
  }
});

router.patch('/:id/cover-letter', verifyToken, async (req, res) => {
  try {
    const { coverLetter } = req.body;

    const updated = await JobApplication.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { coverLetter },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update cover letter' });
  }
});

router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const deleted = await JobApplication.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ message: 'Application deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

router.post('/:id/notes', verifyToken, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const job = await JobApplication.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      {
        $push: {
          notes: { text: text.trim() },
        },
      },
      { new: true }
    );

    if (!job) {
      return res
        .status(404)
        .json({ error: 'Application not found or not yours' });
    }

    return res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create note' });
  }
});

router.patch('/:id/notes/:noteId', verifyToken, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const job = await JobApplication.findOneAndUpdate(
      {
        _id: req.params.id,
        user: req.user._id,
        'notes._id': req.params.noteId,
      },
      {
        $set: {
          'notes.$.text': text.trim(),
          'notes.$.updatedAt': new Date(),
        },
      },
      { new: true }
    );

    if (!job) {
      return res
        .status(404)
        .json({ error: 'Application or note not found' });
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update note' });
  }
});

router.delete('/:id/notes/:noteId', verifyToken, async (req, res) => {
  try {
    const job = await JobApplication.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $pull: { notes: { _id: req.params.noteId } } },
      { new: true }
    );

    if (!job) {
      return res
        .status(404)
        .json({ error: 'Application or note not found' });
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

module.exports = router;
