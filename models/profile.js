
const mongoose = require('mongoose');

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

    links: {
      linkedin: { type: String },
      github: { type: String },
      portfolio: { type: String },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Profile', profileSchema);
