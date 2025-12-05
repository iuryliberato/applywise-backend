const mongoose = require('mongoose');

const experienceSchema = new mongoose.Schema(
  {
    jobTitle: String,
    company: String,
    location: String,
    startDate: String,
    endDate: String,
    description: String,
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    institution: String,
    degree: String,
    fieldOfStudy: String,
    startDate: String,
    endDate: String,
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    fullName: { type: String },
    headline: { type: String },
    location: { type: String },
    summary: { type: String },

    primarySkills: [{ type: String }],
    yearsOfExperience: { type: Number },

    cvUrl: { type: String },
    cvLastParsedAt: { type: Date },

    experience: {
      type: [experienceSchema],
      default: [],
    },

    education: {
      type: [educationSchema],
      default: [],
    },

    links: {
      linkedin: { type: String },
      github: { type: String },
      portfolio: { type: String },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Profile', profileSchema);
