import nodemailer from 'nodemailer';
import config from '../config';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: config.nodemailerUser,
    pass: config.nodemailerPass,
  },
});

type TEmailPayload = {
  to: string;
  subject: string;
  html: string;
};

export const sendEmail = async (payload: TEmailPayload) => {
  if (!config.nodemailerUser || !config.nodemailerPass) {
    console.warn('Email credentials not configured. Skipping send.');
    return null;
  }
  return transporter.sendMail({
    from: `"Smart MMC" <${config.nodemailerUser}>`,
    ...payload,
  });
};