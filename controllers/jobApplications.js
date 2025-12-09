const express = require('express');
const verifyToken = require('../middleware/verify-token');
const JobApplication = require('../models/jobApplication');
const openai = require('../config/openai');
const mongoose = require('mongoose');
const Profile = require('../models/profile');
const PDFDocument = require('pdfkit');

const { normalizeJobUrl } = require('../utils/normalizeJobUrl');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function fetchWithTimeoutAndRetry(
  url,
  options = {},
  { timeoutMs = 20000, retries = 1 } = {}
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);

      const isLast = attempt === retries;
      const aborted = err.name === 'AbortError';

      if (isLast || !aborted) {
        throw err;
      }

      console.warn(`Retrying fetch (${attempt + 1}) for`, url);
    }
  }
}

const router = express.Router();

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// =======================
// Create from link (direct fetch, no ScraperAPI)
// =======================
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

    const finalJobUrl = normalizeJobUrl(jobUrl);
    console.log('Original jobUrl:', jobUrl);
    console.log('Final normalized jobUrl:', finalJobUrl);

    let response;
    try {
      response = await fetchWithTimeoutAndRetry(
        finalJobUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
              'AppleWebKit/537.36 (KHTML, like Gecko) ' +
              'Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        },
        { timeoutMs: 20000, retries: 1 }
      );
    } catch (err) {
      console.error('Error fetching job URL directly:', err);
      return res.status(502).json({
        error:
          'Could not reach that job page. The site may be blocking access or is temporarily down. Try again later or paste the job details manually.',
      });
    }

    const httpStatus = response.status;
    const body = await response.text();

    if (!response.ok) {
      console.error('Direct fetch error:', httpStatus, body.slice(0, 500));

      let message = `Failed to fetch job URL (status ${httpStatus}).`;

      if (httpStatus === 403) {
        message =
          'Could not read that job page. This website is blocking automatic access. Please try a different source, like the company careers page, or paste the job details manually.';
      } else if (httpStatus === 404) {
        message =
          'This job link returned 404 (not found). The posting may have expired or the URL is incorrect.';
      } else if (httpStatus >= 500) {
        message =
          'The job site is having issues. Try again in a bit, or paste the job description manually.';
      }

      return res.status(400).json({
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

// Generate AI-tailored CV as a PDF for a specific job application
router.post('/:id/ai-cv', verifyToken, async (req, res) => {
  try {
    // 1) Load the job application and check ownership
    const job = await JobApplication.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!job) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // 2) Load the user's profile
    const profile = await Profile.findOne({ user: req.user._id });
    if (!profile) {
      return res
        .status(400)
        .json({ error: 'You need to create a profile / upload a CV first' });
    }

    
    
    const profileForAi = {
      fullName: profile.fullName || '',
      headline: profile.headline || '',
      location: profile.location || '',
      summary: profile.summary || '',
      primarySkills: profile.primarySkills || [],
      yearsOfExperience: profile.yearsOfExperience ?? null,
      links: profile.links || {},
    
      experience: (profile.experience || []).map((exp) => ({
        jobTitle: exp.jobTitle || '',
        company: exp.company || '',
        location: exp.location || '',
        startDate: exp.startDate || '',
        endDate: exp.endDate || '',
        description: exp.description || '',
      })),
    
      education: (profile.education || []).map((edu) => ({
        institution: edu.institution || '',
        degree: edu.degree || '',
        fieldOfStudy: edu.fieldOfStudy || '',
        startDate: edu.startDate || '',
        endDate: edu.endDate || '',
      })),
    
      // ✅ from profile. (singular)
      projects: (profile.projects || []).map((proj) => ({
        name: proj.name || '',
        techStack: Array.isArray(proj.techStack)
          ? proj.techStack
          : (proj.tech || '')
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
        link: proj.link || '',
        bullets: Array.isArray(proj.bullets)
          ? proj.bullets
          : (proj.description || '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
      })),
    
      interests: profile.interests || [],
    };
    
    const jobForAi = {
      jobTitle: job.jobTitle || '',
      companyName: job.companyName || '',
      location: job.location || '',
      employmentType: job.employmentType || '',
      seniorityLevel: job.seniorityLevel || '',
      summary: job.summary || '',
      responsibilities: job.responsibilities || [],
      requirements: job.requirements || [],
      niceToHave: job.niceToHave || [],
      perksAndBenefits: job.perksAndBenefits || [],
      salaryInfo: job.salaryInfo || '',
      source: job.source || '',
      // no interests here; they come from profile
    };



    // 4) Ask OpenAI for a structured CV tailored to this job
    const cvSchema = `{
      "fullName": "Jane Doe",
      "headline": "Junior Frontend Engineer",
      "contact": {
        "email": "jane.doe@email.com",
        "location": "Dublin, Ireland",
        "linkedin": "https://www.linkedin.com/in/jane-doe",
        "github": "https://github.com/janedoe",
        "portfolio": "https://janedoe.dev"
      },
      "summary": "2–3 line professional summary tailored to the target role.",
      "skills": {
        "frontend": ["React", "TypeScript", "HTML5", "CSS3"],
        "backend": ["Node.js", "Express"],
        "toolsAndPractices": ["Git", "Jest", "Agile", "CI/CD"],
        "languages": ["English", "Portuguese"]
      },
      "experience": [
        {
          "company": "Company Name",
          "role": "Job Title",
          "location": "City, Country",
          "start": "MMM YYYY",
          "end": "MMM YYYY or 'Present'",
          "bullets": [
            "Achievement-focused bullet with impact.",
            "Another bullet."
          ]
        }
      ],
      "projects": [
        {
          "name": "Project Name",
          "techStack": ["React", "Node.js", "MongoDB"],
          "bullets": [
            "Short bullet describing what you built and why it matters."
          ]
        }
      ],
      "education": [
        {
          "school": "School or Bootcamp Name",
          "degree": "Course / Degree",
          "start": "MMM YYYY",
          "end": "MMM YYYY"
        }
      ],
      "interests": ["Open-source", "Hiking", "Mentoring juniors"],
      "layoutHints": {
        "sections": [
          { "id": "summary",    "dividerAfter": true,  "keepTogether": true },
          { "id": "skills",     "dividerAfter": true,  "keepTogether": true },
          { "id": "experience", "dividerAfter": true,  "keepTogether": true },
          { "id": "projects",   "dividerAfter": true,  "keepTogether": true },
          { "id": "education",  "dividerAfter": true,  "keepTogether": true },
          { "id": "extras",     "dividerAfter": false, "keepTogether": true }
        ]
      }
    }`;
    

    const messages = [
      {
        role: 'system',
        content: `
    You are an expert recruiter and CV writer for software engineering and tech roles.
    
    Your job in this conversation is to take the candidate profile and job description and produce a SINGLE JSON object representing a tailored CV that matches the provided schema.
    
    You MUST silently apply the following behaviours:
    
    --------------------------------------
    1) Act as a recruiter
    - Review the candidate's profile and background as if you were screening their resume.
    - Identify weak areas, vague wording, overused buzzwords, generic phrases, and missing metrics.
    - Fix these issues directly in your rewritten CV content. Do NOT output critique separately.
    
    --------------------------------------
    2) Rewrite for impact
    - Rewrite the CV to sound more results-driven, quantifiable, and compelling for the target role.
    - Focus on achievements, not just duties or responsibilities.
    - Use strong, varied action verbs and clear, concise language.
    
    --------------------------------------
    3) ATS boost
    - Optimise the CV for Applicant Tracking Systems (ATS) for the specific role and title in the job data.
    - Naturally incorporate relevant, industry-specific keywords from:
      - the job description, and
      - common practice for that role (software engineering / web development).
    - Maintain human readability. Do NOT keyword-stuff or repeat awkward phrases.
    
    --------------------------------------
    4) Craft my hook (Professional Summary)
    - Write a powerful 2–3 line professional summary that could hook a recruiter in under 10 seconds.
    - Prioritise impact, clarity, and the candidate's value to the company for this specific role.
    - The summary should sit at the top of the CV and clearly position the candidate for the target role.
    
    --------------------------------------
    5) Upgrade experience
    - Rephrase the experience section to highlight impact, results, and transferable skills.
    - Use action verbs and quantifiable outcomes wherever possible.
    - Tie responsibilities back to outcomes (e.g. improvements in quality, speed, reliability, customer satisfaction, team effectiveness).
    - Never invent fake companies, degrees, or technologies. Keep metrics conservative and realistic.
    
    --------------------------------------
    6) Format fix (content-level format, not visual CSS)
    - Organise the CV content into a clean, modern, single-column structure that works for humans and ATS.
    - Use this logical section order in the JSON: Summary, Skills, Experience, Projects, Education, Interests/Extras.
    - Make sure:
      - skills are grouped as requested by the schema (frontend, backend, toolsAndPractices, languages),
      - education and projects use bullet-style entries (short, clear lines),
      - interests are provided as short bulletable phrases.
    - Do NOT output any visual styling code (CSS, HTML, PDF instructions). Only provide structured data as per the schema.
    
    --------------------------------------
    Layout hints and semantics
    - Populate the "contact" object with separate fields: email, location, linkedin, github, portfolio.
    - Populate the "skills" object as arrays under: frontend, backend, toolsAndPractices, languages.
    - Populate the optional "layoutHints.sections" array exactly as in the schema so the renderer can:
      - keep sections together on one page ("keepTogether": true),
      - draw subtle grey dividers between sections ("dividerAfter": true/false).
    
    --------------------------------------
    7) Projects formatting
    - For each item in the "projects" array:
    - Use "name" as the project title.
    - Use "bullets" as an array of EXACTLY TWO bullet points.
    - Bullet 1: one concise sentence describing what the project is, key features, and (if available) context like Solo/Group and duration.
    - Bullet 2: one concise sentence describing the candidate's concrete contributions, impact, or implementation details.
    - Keep bullets short, resume-style, and easy to scan.
    - Do NOT output separate "Tech: ..." lines; if relevant, mention technologies inside the bullets themselves.
     
    8) Experience Formatting 
    - For each role in the "experience" array:
    - Provide a "bullets" array with EXACTLY TWO bullet points.
    - Bullet 1: a concise sentence summarising the core responsibilities and scope.
    - Bullet 2: a concise sentence highlighting measurable impact, improvements, or key achievements.
    - Keep bullets short, scannable, and focused on outcomes (not generic duties).
    - Do NOT use paragraphs in experience; always use bullet points.

    --------------------------------------
    Global rules
    - Target roughly 1–2 pages of CV content.
    - Never invent fake companies, degrees, or specific technologies.
    - You MUST NOT invent employers, dates, degrees, certifications, or technologies that are not present in the user data.
    - You MUST NOT invent any data that doesn't exist in the profile user data.
    - You MAY rephrase text to be clearer, more concise, or more impactful.
    - Contact and skills data must come from the candidate profile or the job
     description only. If something is missing, leave it blank or omit it.
    - Map profile.projects → CV "projects" (preserve names/links; you may rewrite bullets).
    - Map the "projects" array in the candidate profile JSON to the CV "projects" section.
    - Map profile.interests → CV "interests" as short phrases.
     - Do NOT invent new projects or interests that are not in profile.projects/profile.interests.
    - Do NOT output critique or explanation. Silently apply all improvements inside the final CV data.
    - Output ONLY valid JSON matching the schema string given by the user, with no extra commentary before or after.
        `.trim(),
      },
      {
        role: 'user',
        content: `
    Here is the candidate profile (parsed from their CV) as JSON:
    <profile>
    ${JSON.stringify(profileForAi)}
    </profile>
    
    Here is the job description and metadata as JSON:
    <job>
    ${JSON.stringify(jobForAi)}
    </job>
    
    Return a JSON object with this exact shape:
    
    ${cvSchema}
        `.trim(),
      },
    ];
    


    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages,
      temperature: 0.4,
    });

    const raw = completion.choices[0]?.message?.content || '{}';

    let cvData;
    try {
      cvData = JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse AI CV JSON:', raw);
      return res
        .status(500)
        .json({ error: 'Failed to parse AI response as JSON for CV' });
    }
    
    // ⬇️ NEW: save on the job
      job.aiCvData = cvData;
      job.aiCvUpdatedAt = new Date();
      await job.save();

      return res.json({ cvData: job.aiCvData });

  } catch (err) {
    console.error('Error generating AI CV:', err);
    // Only send JSON error if headers not already sent
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to generate AI CV' });
    }
  }
  
});

router.get('/:id/ai-cv/pdf', verifyToken, async (req, res) => {
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
      return res
        .status(400)
        .json({ error: 'You need to create a profile / upload a CV first' });
    }

    const cvData = job.aiCvData;
    if (!cvData) {
      return res
        .status(400)
        .json({ error: 'No AI CV found. Generate one first.' });
    }


    streamCvPdf(res, cvData, profile);
  } catch (err) {
    console.error('Error exporting AI CV PDF:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to export AI CV PDF' });
    }
  }
});



//helper function
function streamCvPdf(res, cvData, profile) {
  const safeName =
    (cvData.fullName || profile.fullName || 'cv')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cv';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${safeName}-${Date.now()}.pdf"`
  );

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
  });

  doc.pipe(res);

  // ---- Vertical rhythm helpers (spacing scale) ----
// All spacing uses these values so it feels consistent everywhere.
const SPACING = {
  xs: 0.15, // tiny
  sm: 0.3,  // small
  md: 0.5,  // medium
  lg: 0.8,  // large
};

// Convenience helpers
function spaceXs(doc) {
  doc.moveDown(SPACING.xs);
}
function spaceSm(doc) {
  doc.moveDown(SPACING.sm);
}
function spaceMd(doc) {
  doc.moveDown(SPACING.md);
}
function spaceLg(doc) {
  doc.moveDown(SPACING.lg);
}
// subtle grey divider line
function drawDivider(doc) {
  const y = doc.y + 3;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5)
    .strokeColor('#C6C6C6')
    .stroke()
    .strokeColor('#000000'); // reset text
  spaceSm(doc); // space after divider
}

// section header
function drawSectionHeader(doc, title) {
  spaceSm(doc); // space before header
  doc
    .fontSize(11)
    .font('Helvetica-Bold')
    .text(title.toUpperCase(), { align: 'left' });
  spaceXs(doc); // tiny gap to content
}

// very simple keepTogether: start new page if we're too low
function ensureSpaceForSection(doc, approxHeight) {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  if (doc.y + approxHeight > bottomLimit) {
    doc.addPage();
  }
}


// ====== PDF LAYOUT ======

const layoutHints = cvData.layoutHints || {};
const sectionHints = Array.isArray(layoutHints.sections)
  ? layoutHints.sections.reduce((map, s) => {
      map[s.id] = s;
      return map;
    }, {})
  : {};

doc
  .fontSize(20)
  .font('Helvetica-Bold')
  .text(cvData.fullName || profile.fullName || '', { align: 'left' });

if (cvData.headline || profile.headline) {
  spaceXs(doc);
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .text(cvData.headline || profile.headline, { align: 'left' });
}

// CONTACT (with bold labels)
const contact = cvData.contact || {};
if (
  contact.email ||
  contact.location ||
  contact.linkedin ||
  contact.github ||
  contact.portfolio
) {
  spaceMd(doc);
  drawDivider(doc);
  spaceLg(doc)

  if (contact.email) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('Email: ', { continued: true })
      .font('Helvetica')
      .text(contact.email);
  }

  if (contact.location) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('Location: ', { continued: true })
      .font('Helvetica')
      .text(contact.location);
  }

  if (contact.linkedin) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('LinkedIn: ', { continued: true })
      .font('Helvetica')
      .text(contact.linkedin);
  }

  if (contact.github) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('GitHub: ', { continued: true })
      .font('Helvetica')
      .text(contact.github);
  }

  if (contact.portfolio) {
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .text('Portfolio: ', { continued: true })
      .font('Helvetica')
      .text(contact.portfolio);
  }
}

// gap then divider
spaceLg(doc);
drawDivider(doc);
spaceLg(doc)
// ---- SUMMARY ----
if (cvData.summary) {
  const hint = sectionHints.summary || {};
  ensureSpaceForSection(doc, 90);

  drawSectionHeader(doc, 'Professional Summary');

  spaceSm(doc);

  doc
    .fontSize(10)
    .font('Helvetica')
    .text(cvData.summary, { align: 'left' });

    spaceLg(doc);
  if (hint.dividerAfter !== false) drawDivider(doc);
}
spaceLg(doc)
// ---- SKILLS ----
if (cvData.skills) {
  const hint = sectionHints.skills || {};
  const skills = cvData.skills;

  ensureSpaceForSection(doc, 110);
  drawSectionHeader(doc, 'Technical Skills');
  spaceXs(doc);
  doc.fontSize(10);

  if (skills.frontend?.length) {
    doc
      .font('Helvetica-Bold')
      .text('Frontend: ', { continued: true })
      .font('Helvetica')
      .text(skills.frontend.join(', '));
  }

  if (skills.backend?.length) {
    doc
      .font('Helvetica-Bold')
      .text('Backend: ', { continued: true })
      .font('Helvetica')
      .text(skills.backend.join(', '));
  }

  if (skills.toolsAndPractices?.length) {
    doc
      .font('Helvetica-Bold')
      .text('Tools & Practices: ', { continued: true })
      .font('Helvetica')
      .text(skills.toolsAndPractices.join(', '));
  }

  if (skills.languages?.length) {
    doc
      .font('Helvetica-Bold')
      .text('Languages: ', { continued: true })
      .font('Helvetica')
      .text(skills.languages.join(', '));
  }

  spaceLg(doc);
  if (hint.dividerAfter !== false) drawDivider(doc);
}
spaceLg(doc)

// ---- PROJECTS ----
if (Array.isArray(cvData.projects) && cvData.projects.length > 0) {
  const hint = sectionHints.projects || {};

  ensureSpaceForSection(doc, cvData.projects.length * 60);
  drawSectionHeader(doc, 'Projects');
  spaceXs(doc);

  cvData.projects.forEach((proj, idx) => {
    // Project title line
    if (proj.name) {
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(`${proj.name} - Tech: ${proj.techStack.join(', ')}`);
    }

    // Exactly TWO bullets, short + clean
    const bullets = Array.isArray(proj.bullets)
      ? proj.bullets.filter((b) => b && b.trim()).slice(0, 2)
      : [];

    if (bullets.length > 0) {
      spaceXs(doc);
      bullets.forEach((b) => {
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(`• ${b.trim()}`, { indent: 10 });
      });
    }

    // Small gap between projects
    if (idx < cvData.projects.length - 1) {
      spaceSm(doc);
    }
  });

  spaceLg(doc);
  if (hint.dividerAfter !== false) drawDivider(doc);
}


spaceLg(doc)
// ---- EXPERIENCE ----
if (Array.isArray(cvData.experience) && cvData.experience.length > 0) {
  const hint = sectionHints.experience || {};

  ensureSpaceForSection(doc, cvData.experience.length * 70);
  drawSectionHeader(doc, 'Experience');
  spaceXs(doc);

  cvData.experience.forEach((exp, idx) => {
    // Role + company (bold)
    if (exp.role || exp.company) {
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(exp.role || '', { continued: !!exp.company })
        .font('Helvetica-Bold')
        .text(exp.company ? ` — ${exp.company} (${exp.location} | ${exp.start || ''} – ${exp.end || 'Present'})` : '');
    }

    // Bullets: EXACTLY TWO, short + impact-focused
    const bullets = Array.isArray(exp.bullets)
      ? exp.bullets.filter((b) => b && b.trim()).slice(0, 2)
      : [];

    if (bullets.length > 0) {
      spaceXs(doc);
      bullets.forEach((b) => {
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(`• ${b.trim()}`, { indent: 10 });
      });
    }

    // gap between jobs
    if (idx < cvData.experience.length - 1) {
      spaceSm(doc);
    }
  });

  spaceLg(doc);
  if (hint.dividerAfter !== false) drawDivider(doc);
}

spaceLg(doc)
if (Array.isArray(cvData.education) && cvData.education.length > 0) {
  const hint = sectionHints.education || {};

  ensureSpaceForSection(doc, cvData.education.length * 24);
  drawSectionHeader(doc, 'Education');
  spaceXs(doc);
  cvData.education.forEach((edu, idx) => {
    const parts = [];
    if (edu.degree) parts.push(edu.degree);
    if (edu.school) parts.push(edu.school);
    const baseLine = parts.join(' — ');

    const period = `${edu.start || ''} – ${edu.end || ''}`.trim();
    const fullLine =
      period && period !== '–'
        ? `${baseLine} (${period})`
        : baseLine;

    if (fullLine) {
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(`• ${fullLine}`, { indent: 10 });
    }

    if (idx < cvData.education.length - 1) {
      spaceXs(doc);
    }
  });

  spaceLg(doc)
  if (hint.dividerAfter !== false) drawDivider(doc);
}

spaceLg(doc)
// ---- INTERESTS ----
const interests = Array.isArray(cvData.interests)
  ? cvData.interests
  : Array.isArray(cvData.extras)
    ? cvData.extras
    : [];

if (interests.length > 0) {
  const hint = sectionHints.extras || {};

  ensureSpaceForSection(doc, interests.length * 18 + 40);
  drawSectionHeader(doc, 'Interests');
  spaceXs(doc);
  interests.forEach((interest, idx) => {
    if (interest && interest.trim()) {
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(`• ${interest.trim()}`, { indent: 10 });
    }
    if (idx < interests.length - 1) {
      spaceXs(doc);
    }
  });

  spaceMd(doc);
  if (hint.dividerAfter !== false) drawDivider(doc);
}
  doc.end();
}

// Update the stored AI CV after user edits (expects JSON in same shape)
router.put('/:id/ai-cv', verifyToken, async (req, res) => {
  try {
    const { cvData } = req.body;

    const job = await JobApplication.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!job) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (!cvData || typeof cvData !== 'object') {
      return res.status(400).json({ error: 'cvData must be an object' });
    }

    job.aiCvData = cvData;
    job.aiCvUpdatedAt = new Date();
    await job.save();

    res.json({ cvData: job.aiCvData });
  } catch (err) {
    console.error('Error updating AI CV:', err);
    res.status(500).json({ error: 'Failed to update AI CV' });
  }
});



module.exports = router;



  