import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as nodemailer from "nodemailer";
const cors = require("cors")({ origin: true });

const system_url = "https://plan-simply-dmdev.web.app";

export const sendPasswordResetLink = functions.https.onRequest(
  async (req, res) => {
    cors(req, res, () => {
      // getting dest email by query string
      const user_email = req.query.user as string;

      // get password reset link
      admin
        .auth()
        .generatePasswordResetLink(user_email, { url: system_url })
        .then((reset_link) => {
          const mailOptions = {
            //from: "ZeroBase Support <noreply@zerobaseapp.com>",
            from:"hans.luther@gmail.com",
            to: user_email,
            subject: "ZeroBase Password Reset", // email subject
            html: `Hello,<br><br>Follow this link to reset your ZeroBase password for ${user_email}:<br><br>
            ${reset_link}<br><br>
            Once your password is reset, you may access the system here: ${system_url}<br><br>
            If you didn’t ask to reset your password, you can ignore this email.<br><br>
            Your ZeroBase Support team`, // email content in HTML
          };

          const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
              user: "hans.luther@gmail.com",
              pass: "eeqjbuodxvcazsyb",
            },
          });

          transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
              console.log(
                `Error occured sending mail: ${JSON.stringify(error)}`
              );
              return res.send(`Unknown error. Please contact support`);
            } else {
              return res.send(
                `Request submitted. Link will be sent if a user with email address ${user_email} exists.`
              );
            }
          });
        })
        .catch((error) => {
          console.log(
            `Error occured generating password link: ${JSON.stringify(error)}`
          );
          return res.send(
            `Request submitted. Link will be sent if a user with email address ${user_email} exists.`
          );
        });
    });
  }
);
