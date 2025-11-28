// routes/jobApplications.js
const express = require('express');
const verifyToken = require('../middleware/verify-token');
const JobApplication = require('../models/jobApplication');
const openai = require('../config/openai');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));


const router = express.Router();

// util: naive HTML → text
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// POST /job-applications/from-link
router.post('/from-link', verifyToken, async (req, res) => {
    try {
        const { jobUrl, status } = req.body;
    
        if (!jobUrl) {
          return res.status(400).json({ error: 'jobUrl is required' });
        }
    
      
       const ALLOWED_STATUSES = ['Idea', 'Applied', 'Interviewing', 'Tech-Test', 'Offer', 'Rejected'];

       const normalizedStatus = ALLOWED_STATUSES.includes(status) ? status : 'Idea';   

    // 1) Fetch the job page
    const response = await fetch(jobUrl);
    if (!response.ok) {
      return res
        .status(400)
        .json({ error: `Failed to fetch job URL (status ${response.status})` });
    }

    const html = await response.text();
    const text = stripHtml(html);

    // Optional: limit length sent to AI
    const textForAi = text.slice(0, 12000); // ~ reasonable chunk

    // 2) Build AI prompt to structure the job description
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

- "summary" should be a short paragraph (3–5 sentences).
- "responsibilities", "requirements", "niceToHave", "perksAndBenefits" should be bullet points.
- "source" should be a short label like "LinkedIn", "Indeed", "Company Site" if you can guess it, otherwise "".

JOB PAGE TEXT:
${textForAi}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // or gpt-4.1-mini
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an assistant that extracts structured job data from messy web page text. Return ONLY JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const raw = completion.choices[0].message.content;
    console.log('AI job JSON:', raw);

    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse AI JSON for job:', err);
      return res
        .status(500)
        .json({ error: 'Failed to parse AI response as JSON' });
    }

    // 3) Create JobApplication in DB
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
    console.error('Job from link error:', err);
    return res.status(500).json({ error: 'Failed to process job link' });
  }
});

// GET /job-applications/my → all applications for the logged-in user
router.get('/my-application', verifyToken, async (req, res) => {
    try {
      const apps = await JobApplication.find({ user: req.user._id })
        .sort({ createdAt: -1 });
      res.json(apps);
    } catch (err) {
      console.error('Get my applications error:', err);
      res.status(500).json({ error: 'Failed to fetch applications' });
    }
  });
  router.get('/:id', verifyToken, async (req, res) => {
    try {
      console.log('GET /job-applications/:id', req.params.id, 'user', req.user?._id);
  
      const app = await JobApplication.findOne({
        _id: req.params.id,
        user: req.user._id,  // only owner can see it
      });
  
      if (!app) {
        return res.status(404).json({ error: 'Application not found' });
      }
  
      res.json(app);
    } catch (err) {
      console.error('Get one application error:', err);
      res.status(500).json({ error: 'Failed to fetch application' });
    }
  });
  // PATCH /job-applications/:id/status → update status for a single job
router.patch('/:id/status', verifyToken, async (req, res) => {
  try {
    const { status } = req.body;

    const ALLOWED_STATUSES = ['Idea', 'Applied', 'Interviewing', 'Tech-Test', 'Offer', 'Rejected'];
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
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});


module.exports = router;
