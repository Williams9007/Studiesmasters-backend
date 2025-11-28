export const assignRole = (req, res) => {
  const { userId, role } = req.body;
  // TODO: update user role in DB
  res.json({ success: true, message: `Role ${role} assigned to user ${userId}` });
};
