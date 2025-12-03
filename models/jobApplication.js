// models/jobApplication.js
const mongoose = require('mongoose');

// --- Note subdocument schema ---
const noteSchema = new mongoose.Schema(
    {
      text: { type: String, required: true },
  
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date },
    },
    {
      _id: true, 
    }
  );

const jobApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    jobUrl: {
      type: String,
    },

    source: {
      type: String, // e.g. 'LinkedIn', 'Indeed', 'Company Site'
    },

    jobTitle: {
      type: String,
    },

    companyName: {
      type: String,
      required: true,
    },

    location: {
      type: String,
    },

    employmentType: {
      type: String, // e.g. 'Full-time', 'Contract'
    },

    seniorityLevel: {
      type: String, // e.g. 'Junior', 'Mid', 'Senior'
    },

    // AI-generated summary fields
    summary: {
      type: String,
      required: true,
    },

    responsibilities: {
      type: [String], // bullet points
      default: [],
    },

    requirements: {
      type: [String], // bullet points
      default: [],
    },

    niceToHave: {
      type: [String],
      default: [],
    },
    perksAndBenefits: {
        type: [String],
        default: [],
      },

    salaryInfo: {
      type: String,
    },

    // Optional: raw text snippet that AI used
    rawTextSnippet: {
      type: String,
    },

    // Status of YOUR application
    status: {
      type: String,
      enum: ['Idea', 'Applied', 'Interviewing', 'Tech Test', 'Offer', 'Rejected'],
      default: 'Idea',
    },
    notes: [noteSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
