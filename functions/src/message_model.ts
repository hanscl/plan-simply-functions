import * as admin from 'firebase-admin';

export interface UINotificationMessage {
  is_new: boolean;
  subject: string;
  message: string;
  link?: { display_text: string; url: string };
  received_at: admin.firestore.Timestamp;
  viewed_at?: admin.firestore.Timestamp;
}
