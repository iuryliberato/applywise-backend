const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { _id: true }
);

const jobApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    jobUrl: { type: String },
    source: { type: String },

    jobTitle: { type: String },
    companyName: { type: String, required: true },
    location: { type: String },

    employmentType: { type: String },
    seniorityLevel: { type: String },

    summary: {
      type: String,
      required: true,
    },

    responsibilities: {
      type: [String],
      default: [],
    },

    requirements: {
      type: [String],
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

    salaryInfo: { type: String },
    rawTextSnippet: { type: String },

    status: {
      type: String,
      enum: ['Idea', 'Applied', 'Interviewing', 'Tech Test', 'Offer', 'Rejected'],
      default: 'Idea',
    },

    coverLetter: { type: String },

    notes: [noteSchema],
    aiCvData: {
      type: mongoose.Schema.Types.Mixed,
    },
    aiCvUpdatedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('JobApplication', jobApplicationSchema);
