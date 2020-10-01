import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as nodemailer from "nodemailer";
const cors = require("cors")({ origin: true });
const key = require("../alert-condition-291223-fe5b366c5ed9.json");
 

export const sendPasswordResetLink = functions.https.onRequest(
  async (req, res) => {
    cors(req, res, async () => {
      // getting dest email by query string
      const user_email = req.query.user as string;
      const support_send_email = "noreply@zerobaseapp.com";

      // try to build the project URL
      let system_url = "";
      let system_forward_text = "";
      if(admin.app().options.projectId !== undefined) {
        system_url = `https://${admin.app().options.projectId}.web.app`;
        system_forward_text = `Once your password is reset, you may access the system here: ${system_url}<br><br>`;
      }

      // get password reset link
      admin
        .auth()
        .generatePasswordResetLink(user_email, { url: system_url })
        .then(async (reset_link) => {
          const mailOptions = {
            //from: "ZeroBase Support <noreply@zerobaseapp.com>",
            from: support_send_email,
            to: user_email,
            subject: "ZeroBase Password Reset", // email subject
            html: `Hello,<br><br>Follow this link to reset your ZeroBase password for ${user_email}:<br><br>
            ${reset_link}<br><br>
            ${system_forward_text}
            If you didn’t ask to reset your password, you can ignore this email.<br><br>
            Your ZeroBase Support team`, // email content in HTML
          };

          // const transporter = nodemailer.createTransport({
          //   service: "gmail",
          //   auth: {
          //     user: "hans.luther@gmail.com",
          //     pass: "eeqjbuodxvcazsyb",
          //   },
          // });

          const transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
              type: "OAuth2",
              user: support_send_email,
              serviceClient: key.client_id,
              privateKey: key.private_key,
            },
          });

          await transporter.verify();
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
