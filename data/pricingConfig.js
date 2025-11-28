// src/Data/pricingConfig.js

// Complete pricing table with actual amounts
export const pricingTable = {
  GES: {
    EC: {
      "1-4": { English: 600, Maths: 600, Science: 800 },
      "5-6": { English: 650, Maths: 650, Science: 800 },
      "JHS 1-3": { English: 700, Maths: 700, Science: 850 },
      "SHS 1-3": { English: 750, Maths: 750, Science: 850 },
    },
    WC: {
      "1-4": { English: 600, Maths: 600, Science: 800 },
      "5-6": { English: 650, Maths: 650, Science: 800 },
      "JHS 1-3": { English: 700, Maths: 700, Science: 850 },
      "SHS 1-3": { English: 750, Maths: 750, Science: 850 },
    },
    HS: "CALL",
    SC: {
      "1-4": { English: 1500, Maths: 1500, Science: 1500 },
      "5-6": { English: 2000, Maths: 2000, Science: 2000 },
      "JHS 1-3": { English: 2500, Maths: 2500, Science: 2500 },
    },
    VC: {
      "SHS 1-3": { English: 250, Maths: 250, Science: 300 },
    },
  },

  Cambridge: {
    EC: {
      "Stage 4-6": { English: 900, Maths: 1000, "Combined Science": 1200 },
      "Stage 7-11": { English: 950, Maths: 1050, "Combined Science": 1250 },
      "Stage 12-13": { English: 1000, Maths: 1100, "Combined Science": 1300 },
    },
    WC: {
      "Stage 4-6": { English: 900, Maths: 1000, "Combined Science": 1200 },
      "Stage 7-11": { English: 950, Maths: 1050, "Combined Science": 1250 },
      "Stage 12-13": { English: 1000, Maths: 1100, "Combined Science": 1300 },
    },
    SC: {
      "Stage 4-6": "CALL",
      "Stage 7-11": "CALL",
      "Stage 12-13": "CALL",
    },
    OC: {
      "Stage 4-6": { English: 1800, Maths: 2000, "Combined Science": 2400 },
      "Stage 7-11": { English: 1800, Maths: 2000, "Combined Science": 2400 },
      "Stage 12-13": { English: 1800, Maths: 2000, "Combined Science": 2400 },
    },
  },
};

// Minimal pricing metadata for grade/subject selection in auth form
export const pricing = {
  GES: {
    packages: {
      EC: {
        grades: ["1-4", "5-6", "JHS 1-3", "SHS 1-3"],
        subjectsByGrade: {
          "1-4": ["English", "Maths", "Science"],
          "5-6": ["English", "Maths", "Science"],
          "JHS 1-3": ["English", "Maths", "Science"],
          "SHS 1-3": ["English", "Maths", "Science"],
        },
      },
      WC: {
        grades: ["1-4", "5-6", "JHS 1-3", "SHS 1-3"],
        subjectsByGrade: {
          "1-4": ["English", "Maths", "Science"],
          "5-6": ["English", "Maths", "Science"],
          "JHS 1-3": ["English", "Maths", "Science"],
          "SHS 1-3": ["English", "Maths", "Science"],
        },
      },
    },
  },
  Cambridge: {
    packages: {
      EC: {
        grades: ["Stage 4-6", "Stage 7-11", "Stage 12-13"],
        subjectsByGrade: {
          "Stage 4-6": ["English", "Maths", "Combined Science"],
          "Stage 7-11": ["English", "Maths", "Combined Science"],
          "Stage 12-13": ["English", "Maths", "Combined Science"],
        },
      },
      WC: {
        grades: ["Stage 4-6", "Stage 7-11", "Stage 12-13"],
        subjectsByGrade: {
          "Stage 4-6": ["English", "Maths", "Combined Science"],
          "Stage 7-11": ["English", "Maths", "Combined Science"],
          "Stage 12-13": ["English", "Maths", "Combined Science"],
        },
      },
      OC: {
        grades: ["Stage 4-6", "Stage 7-11", "Stage 12-13"],
        subjectsByGrade: {
          "Stage 4-6": ["English", "Maths", "Combined Science"],
          "Stage 7-11": ["English", "Maths", "Combined Science"],
          "Stage 12-13": ["English", "Maths", "Combined Science"],
        },
      },
    },
  },
};

// ✅ Helper functions

// Return array of grades for a curriculum + package
export function getGradesForCurriculum(curriculum, packageName) {
  if (!curriculum || !packageName) return [];
  const pkg = pricing[curriculum]?.packages?.[packageName];
  return Array.isArray(pkg?.grades) ? pkg.grades : [];
}

// Return subjects for a curriculum/package/grade
export function getSubjectsForPackage(curriculum, packageName, gradeGroup) {
  if (!curriculum || !packageName || !gradeGroup) return [];
  return pricing[curriculum]?.packages?.[packageName]?.subjectsByGrade?.[gradeGroup] || [];
}

// Return price for a specific curriculum/grade/subject
export function getSubjectPrice(curriculum, gradeGroup, subject) {
  if (!curriculum || !gradeGroup || !subject) return 0;
  const pkgList = pricingTable[curriculum];
  if (!pkgList) return 0;

  for (const pkgName of Object.keys(pkgList)) {
    const grades = pkgList[pkgName];
    if (grades && grades[gradeGroup] && typeof grades[gradeGroup][subject] === "number") {
      return grades[gradeGroup][subject];
    }
  }
  return 0;
}
