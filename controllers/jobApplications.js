// routes/jobApplications.js
const express = require('express');
const verifyToken = require('../middleware/verify-token');
const JobApplication = require('../models/jobApplication');
const openai = require('../config/openai');
const mongoose = require('mongoose');
const Profile = require('../models/profile');    
 

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

// POST /job-applications
// Create a job application manually (no link/AI)
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
        // expect arrays; fallback to [] if not provided
        responsibilities: responsibilities || [],
        requirements: requirements || [],
        niceToHave: niceToHave || [],
        perksAndBenefits: perksAndBenefits || [],
        salaryInfo,
        status,              // schema will lowercase if you set lowercase: true
        source: source || 'Manual',
      });
  
      res.status(201).json(job);
    } catch (err) {
      console.error('Create manual job error:', err);
      res.status(500).json({ error: 'Failed to create application' });
    }
  });
  
router.get('/my-applications', verifyToken, async (req, res) => {
    try {
      const { status } = req.query;
      const ALLOWED_STATUSES = ['Idea', 'Applied', 'Interviewing', 'Tech-Test', 'Offer', 'Rejected'];
  
      // Always filter by user
      const query = { user: req.user._id };
  
      // ✅ Only filter by status if the client actually sent a valid one
      if (status && ALLOWED_STATUSES.includes(status)) {
        query.status = status;
      }
  
      const apps = await JobApplication
        .find(query)
        .sort({ updatedAt: -1 });
  
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
  
      const ALLOWED_STATUSES = ['Idea', 'Applied', 'Interviewing', 'Tech-Test', 'Offer', 'Rejected'];
  
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
      console.error('Get applications summary error:', err);
      res.status(500).json({ error: 'Failed to fetch summary' });
    }
  });
  
  
  // GET /job-applications/my/recent?limit=5
router.get('/my-applications/recent', verifyToken, async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 5;
  
      const apps = await JobApplication
        .find({ user: req.user._id })
        .sort({ updatedAt: -1 })
        .limit(limit);
  
      res.json(apps);
    } catch (err) {
      console.error('Get recent applications error:', err);
      res.status(500).json({ error: 'Failed to fetch recent applications' });
    }
  });
  
  // POST /job-applications/:id/cover-letter
// Generate a tailored cover letter based on the user's profile and this job
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
  
      // Build a compact prompt with relevant info
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
  - Refer to responsibilities/requirements in a natural way (no bullet points, just paragraphs).
  - Keep it to about 3–5 paragraphs, max 450–500 words.
  - Do NOT invent experience that is not in the profile.
  
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
        // no text.format → default plain text
      });
  
      // Safely extract text
      let coverLetter = '';
      if (response.output_text) {
        coverLetter = response.output_text;
      } else if (
        response.output &&
        response.output[0] &&
        response.output[0].content &&
        response.output[0].content[0] &&
        response.output[0].content[0].text
      ) {
        coverLetter = response.output[0].content[0].text;
      }
  
      return res.json({ coverLetter });
    } catch (err) {
      console.error('Cover letter error:', err);
      return res.status(500).json({ error: 'Failed to generate cover letter' });
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
      console.error('Delete application error:', err);
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
      { _id: req.params.id, user: req.user._id }, // ensure it belongs to the logged-in user
      {
        $push: {
          notes: {
            text: text.trim(),
          },
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
    console.error('Create note error:', err);
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
    console.error('Update note error:', err);
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
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

module.exports = router;
