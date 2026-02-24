// controllers/notificationController.js

// Mock notifications array (replace later with DB)
let notifications = [
  { id: 1, message: "New user signed up", read: false, createdAt: new Date() },
  { id: 2, message: "Server restarted", read: false, createdAt: new Date() },
];

// Get all notifications
export const getNotifications = (req, res) => {
  res.json({ notifications });
};

// Mark a notification as read
export const markRead = (req, res) => {
  const { id } = req.params;
  notifications = notifications.map((n) =>
    n.id === parseInt(id) ? { ...n, read: true } : n
  );
  res.json({ success: true });
};
