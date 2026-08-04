export const paymentPlans = {
  GES: [
    { name: "Starter Plan", price: 250, duration: "1 month" },
    { name: "Standard Plan", price: 500, duration: "1 month" },
    { name: "Premium Plan", price: 900, duration: "1 month" },
  ],
  CAMBRIDGE: [
    { name: "Starter Plan", price: 450, duration: "1 month" },
    { name: "Standard Plan", price: 760, duration: "1 month" },
    { name: "Premium Plan", price: 1200, duration: "1 month" },
  ],
  SAT: [
    { name: "Starter Plan", price: 500, duration: "1 month" },
    { name: "Standard Plan", price: 800, duration: "1 month" },
    { name: "Premium Plan", price: 1300, duration: "1 month" },
  ],
  GCE: [
    { name: "Starter Plan", price: 300, duration: "1 month" },
    { name: "Standard Plan", price: 550, duration: "1 month" },
    { name: "Premium Plan", price: 950, duration: "1 month" },
  ],
};

export const paymentAddOns = {
  GES: [
    { name: "Homework Club", price: 250 },
    { name: "Exams Boost Camp (BECE/WASSCE/NOVDEC)", price: 500 },
  ],
  CAMBRIDGE: [
    { name: "Homework Club", price: 300 },
    { name: "Exams Boost", price: 300 },
    { name: "IGCSE Booster Camp", price: 900 },
    { name: "1 on 1 Private Coaching", price: 3600 },
  ],
  SAT: [
    { name: "Homework Club", price: 350 },
    { name: "SAT Exams Boost", price: 600 },
    { name: "1 on 1 Private Coaching", price: 3600 },
  ],
  GCE: [
    { name: "Homework Club", price: 250 },
    { name: "Exams Boost Camp (O/A-Level)", price: 500 },
  ],
};

export const findPaymentPlan = (curriculum, name) =>
  paymentPlans[curriculum]?.find((plan) => plan.name === name);

export const findPaymentAddOns = (curriculum, names = []) => {
  const selectedNames = Array.isArray(names) ? names : [];
  const available = paymentAddOns[curriculum] || [];
  return selectedNames.map((name) => available.find((addOn) => addOn.name === name));
};
