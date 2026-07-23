import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

console.log("🔥 sendWelcomeMessage.js LOADED");

const resend = new Resend(process.env.RESEND_API_KEY);


// Sender validation
const getFromAddress = () => {

  const email = process.env.RESEND_FROM_EMAIL;

  if (!email) {
    throw new Error(
      "RESEND_FROM_EMAIL is missing in your environment variables"
    );
  }

  return email;

};


// Prevent HTML injection
const escapeHtml = (value) => {
  const s = String(value ?? "");
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const gt = "&" + "gt;";
  const quot = "&" + "quot;";
  const apos = "&#" + "39;";
  return s
    .replaceAll("&", amp)
    .replaceAll("<", lt)
    .replaceAll(">", gt)
    .replaceAll('"', quot)
    .replaceAll("'", apos);
};


// Format arrays
const formatValue = (value) => {

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value || "Not provided";

};



// =====================================
// SEND STUDENT WELCOME EMAIL
// =====================================

export const sendWelcomeEmail = async ({

  userEmail,
  studentName,
  packageName,
  subjects,
  temporaryPassword,
  userId,
  phone,
  curriculum,
  grade,
  preferredDays,
  preferredTime

}) => {


  console.log("Preparing welcome email:");

  console.log({

    userEmail,

    studentName,

    userId

  });



  if (!userId) {

    throw new Error(
      "USER ID missing. Create userId before sending email."
    );

  }



  try {


    const { data, error } = await resend.emails.send({


      from: getFromAddress(),


      reply_to:
        "contactus@studiesmasters.com",


      to: userEmail,


      subject:
        `Welcome to StudiesMasters ${studentName}`,



      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#f0f4f8; font-family:'Segoe UI',Arial,sans-serif;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8; padding:30px 10px;">
<tr>
<td align="center">

  <!-- Main Container -->
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.08);">

    <!-- Header Banner -->
    <tr>
      <td style="background:linear-gradient(135deg, #1d4ed8, #2563eb); padding:40px 40px 30px; text-align:center;">
        <h1 style="color:#ffffff; font-size:28px; margin:0 0 8px; font-weight:700;">Welcome to StudiesMasters</h1>
        <p style="color:#bfdbfe; font-size:16px; margin:0;">Your learning journey begins today</p>
      </td>
    </tr>

    <!-- Body Content -->
    <tr>
      <td style="padding:35px 40px 20px;">

        <!-- Greeting -->
        <p style="font-size:16px; color:#1e293b; margin:0 0 20px; line-height:1.6;">
          Dear <strong style="color:#1d4ed8;">${escapeHtml(studentName)}</strong>,
        </p>
        <p style="font-size:15px; color:#475569; margin:0 0 25px; line-height:1.6;">
          Congratulations! Your registration has been completed successfully. We are excited to have you on board.
        </p>

        <!-- Enrollment Details Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; border-radius:12px; border:1px solid #e2e8f0; margin-bottom:28px;">
          <tr>
            <td style="padding:20px 24px;">
              <h3 style="color:#1d4ed8; font-size:17px; margin:0 0 16px; font-weight:600;">&#x1f4cb; Enrollment Details</h3>
              <table width="100%" cellpadding="7" cellspacing="0">

                <tr>
                  <td width="120" style="font-size:14px; color:#64748b; font-weight:600; vertical-align:top;">User ID:</td>
                  <td style="font-size:16px; color:#1d4ed8; font-weight:700;">${escapeHtml(userId)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Student:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(studentName)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Email:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(userEmail)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Phone:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(phone || "Not provided")}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Curriculum:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(curriculum)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Grade:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(grade)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Package:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(packageName)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600; vertical-align:top;">Subjects:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(formatValue(subjects))}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Class Days:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(formatValue(preferredDays))}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Class Time:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(preferredTime || "To be confirmed")}</td>
                </tr>

              </table>
            </td>
          </tr>
        </table>

        <!-- Login Information Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff; border-radius:12px; border:1px solid #bfdbfe; margin-bottom:28px;">
          <tr>
            <td style="padding:20px 24px;">
              <h3 style="color:#1d4ed8; font-size:17px; margin:0 0 14px; font-weight:600;">&#x1f511; Login Information</h3>
              <p style="font-size:14px; color:#475569; margin:0 0 12px; line-height:1.6;">
                You can log in to your dashboard using any of the following:
              </p>
              <table width="100%" cellpadding="4" cellspacing="0">
                <tr>
                  <td width="140" style="font-size:14px; color:#64748b; font-weight:600;">User ID:</td>
                  <td style="font-size:15px; color:#1d4ed8; font-weight:700;">${escapeHtml(userId)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Email:</td>
                  <td style="font-size:14px; color:#1e293b;">${escapeHtml(userEmail)}</td>
                </tr>
                <tr>
                  <td style="font-size:14px; color:#64748b; font-weight:600;">Temporary Password:</td>
                  <td style="font-size:14px; font-family:monospace; background:#dbeafe; padding:4px 10px; border-radius:4px; display:inline-block; color:#1e293b; font-weight:600;">${escapeHtml(temporaryPassword)}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Dashboard Button -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:30px;">
          <tr>
            <td align="center">
              <a href="https://studiesmasters.com/login" style="display:inline-block; background:#1d4ed8; color:#ffffff; padding:14px 36px; border-radius:8px; text-decoration:none; font-weight:700; font-size:16px;">Login To Dashboard</a>
            </td>
          </tr>
        </table>

        <!-- Learning Guidelines -->
        <h3 style="color:#1d4ed8; font-size:17px; margin:0 0 12px; font-weight:600;">&#x1f4da; Learning Guidelines</h3>
        <p style="font-size:14px; color:#475569; margin:0 0 14px; line-height:1.6;">
          To ensure a productive learning environment, please adhere to the following guidelines:
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Arrive 15 minutes prior to the start of classes &mdash; 10 minutes beforehand.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Bring a notepad and writing instrument to all lessons.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Use your full name when joining online calls for attendance purposes.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Ensure a stable internet connection.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Mute your microphone when a class is in session.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Participate in lessons from a quiet environment for concentration.</td>
          </tr>
        </table>

        <!-- Important Notes -->
        <h3 style="color:#d97706; font-size:15px; margin:0 0 10px; font-weight:600;">&#x26a0;&#xfe0f; Please Also Note</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;">
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; Maintaining personal decorum during lesson hours is your responsibility; failure to do so may result in removal from the class.</td>
          </tr>
          <tr>
            <td style="padding:0 0 6px 20px; font-size:14px; color:#475569; line-height:1.7;">&bull; While keeping your camera on during lessons is not mandatory, if you choose to do so, please ensure you are dressed appropriately to avoid being removed from the class after a prompt.</td>
          </tr>
        </table>

        <!-- Contact -->
        <p style="font-size:14px; color:#475569; margin:0 0 6px; line-height:1.6;">
          Should you have any questions or encounter any difficulties, please do not hesitate to contact us at
          <a href="mailto:contactus@studiesmasters.com" style="color:#1d4ed8; font-weight:600; text-decoration:underline;">contactus@studiesmasters.com</a>.
        </p>

      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:25px 40px 35px; border-top:1px solid #e2e8f0;">
        <p style="font-size:14px; color:#1e293b; margin:0 0 20px; font-weight:600;">Kind regards,<br><span style="color:#1d4ed8;">StudiesMasters</span></p>

        <p style="font-size:11px; color:#94a3b8; margin:0 0 10px; line-height:1.5;">
          The content of this message is confidential. If you have received it by mistake, please inform us by an email reply and then delete the message. It is forbidden to copy, forward, or in any way reveal the contents of this message to anyone.
        </p>
        <p style="font-size:11px; color:#94a3b8; margin:0; line-height:1.5;">
          The integrity and security of this email cannot be guaranteed over the Internet. Therefore, the sender will not be held liable for any damage caused by the message.
        </p>
      </td>
    </tr>

  </table>

  <!-- Footer Note -->
  <p style="font-size:12px; color:#94a3b8; margin:18px 0 0; text-align:center;">
    &copy; 2026 StudiesMasters. All rights reserved.
  </p>

</td>
</tr>
</table>

</body>
</html>
`,


      tags:[

        {

          name:"email_type",

          value:"student_welcome"

        }

      ]


    });



    if(error){

      throw new Error(error.message);

    }



    console.log(
      "Welcome email sent:",
      data.id
    );


    return data;



  } catch(error){


    console.error(
      "Welcome email failed:",
      error.message
    );


    throw error;


  }


};





// =====================================
// ADMIN NOTIFICATION EMAIL
// =====================================

export const notifyAdmin = async (

subject,

message

)=>{


try{


const {data,error}=await resend.emails.send({


from:getFromAddress(),


reply_to:
"contactus@studiesmasters.com",


to:
process.env.ADMIN_EMAIL,


subject,


html:`


<div style="
font-family:Arial;
padding:20px;
">


<h2>
StudiesMasters Admin Notification
</h2>


<p>

${escapeHtml(message).replace(/\n/g,"<br/>")}

</p>



</div>


`


});



if(error){

throw new Error(error.message);

}



return data;



}catch(error){


console.error(
"Admin email failed:",
error.message
);


throw error;


}


};