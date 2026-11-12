# Cloud auto-send setup

The board (`index.html`) stays your control panel. A Firebase Cloud Function sends the due follow-ups to each client's WhatsApp number every day at **10:00 AM IST**, even when the page is closed. The board syncs your projects, rules and history to the cloud, and pulls the send log back.

## 1. WhatsApp Business Cloud API (Meta)
1. In Meta Business, create a WhatsApp Business app and add a number. Note the **Phone number ID**.
2. Create a **permanent access token** (System User) with `whatsapp_business_messaging`.
3. Create and get approved the 10 message templates below (category: Utility). Names must match exactly.

WhatsApp only allows free text to a client who messaged you in the last 24 hours. For everyone else, approved templates are required, so the board sends templates by default. Variables: `{{1}}` = contact or client name, `{{2}}` = project, `{{3}}` = reminder number. Replace "Your Name" with your own name before submitting.

| Template name | Body |
|---|---|
| fu_new_enquiry | Hello {{1}}, thank you for your interest in a website for {{2}}. I would love to understand your goals, pages needed and timeline. Could we schedule a quick 15-minute call this week? Regards, Your Name |
| fu_proposal_sent | Hello {{1}}, I shared the proposal for {{2}} a few days ago (follow-up {{3}}). Do you have any questions about the scope, timeline or pricing? Regards, Your Name |
| fu_advance_pending | Hello {{1}}, thank you for confirming {{2}}. To book your slot and start design, I need the advance payment as per the proposal. Please let me know once it is done. Regards, Your Name |
| fu_awaiting_content | Hello {{1}}, for {{2}} we are waiting on your content (logo, text, photos, product details). Reminder {{3}}: the sooner I receive it, the sooner we can launch. Regards, Your Name |
| fu_in_progress | Hello {{1}}, quick progress update on {{2}}: work is moving as planned and I will share the next preview soon. Update {{3}}. Regards, Your Name |
| fu_review_feedback | Hello {{1}}, the preview of {{2}} is ready for your review. Please check all pages on mobile and desktop and send your feedback in one list (reminder {{3}}). Regards, Your Name |
| fu_final_payment_due | Hello {{1}}, {{2}} is ready to go live. The remaining payment is due before launch and handover. Please confirm the payment date (reminder {{3}}). Regards, Your Name |
| fu_live_handover | Hello {{1}}, your website {{2}} is live. Thank you for working with me! A short Google review or referral would mean a lot. Regards, Your Name |
| fu_custom | Hello {{1}}, {{2}} Regards, Your Name |
| fu_maintenance_offer | Hello {{1}}, it has been a while since {{2}} launched. I offer monthly maintenance (updates, backups, security, small changes). Would you like a plan? Offer {{3}}. Regards, Your Name |

Note: the editable message texts in the board are used for manual sending and for "Plain text" mode. In template mode the approved template text is what clients receive.

## 2. Deploy (Firebase, Blaze plan required for scheduled functions)
```
npm i -g firebase-tools
firebase login
firebase use --add            # pick your project; enable Firestore (native mode)
cd functions && npm install && cd ..
firebase functions:secrets:set WA_TOKEN    # paste the Meta permanent token
firebase functions:secrets:set SYNC_KEY    # choose any long random string
firebase deploy --only functions
```
Deploy prints the URL of `followupApi`.

## 3. Connect the board
Open the board, click **Cloud auto-send**, enter the `followupApi` URL, your SYNC_KEY and the Phone number ID, enable it and press **Save & sync**. Use **Test (dry run)** to see how many messages would go out, then it runs by itself daily.

## Things to know
- Every project needs a valid WhatsApp number (10 digits or with country code), otherwise it is skipped.
- Cadence rules, max follow-ups per stage and the daily cap work exactly as on the board. Failed sends are retried the next day.
- Clients must be people who expect your messages; Meta can restrict numbers that get reported.
- The sync key is stored in this browser. Keep the board's login password strong, since it is a front-end gate only.

## Schedule message form
Sidebar > **Schedule message**: pick one or more clients, write the message (placeholders {name} {client} {project} {sign}), choose date, time and repeat (once, daily, weekly, monthly). A function checks every 5 minutes and sends what is due to each client's WhatsApp number, then shows Sent or Failed in the same form (Retry available). Scheduled messages use the `fu_custom` template in template mode; the message text must be a single line of text (line breaks are flattened).
