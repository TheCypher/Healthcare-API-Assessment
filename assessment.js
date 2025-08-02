/**
 * Healthcare API Assessment
 */

const axios = require("axios");

const API_BASE = "https://assessment.ksensetech.com/api";
const API_KEY = process.env.DEMO_API_KEY || "ak_cc8ac22d880b9d30cfcd67984be07399094c3ba35cc245d8";

if (!API_KEY) {
  console.error("Missing API key. Set DEMO_API_KEY environment variable.");
  process.exit(1);
}

const axiosInstance = axios.create({
  baseURL: API_BASE,
  headers: {
    "x-api-key": API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 10000,
});

async function requestWithRetry(config, attempts = 5) {
  let attempt = 0;
  while (attempt < attempts) {
    try {
      const resp = await axiosInstance.request(config);
      return resp.data;
    } catch (err) {
      attempt++;
      const status = err.response?.status;

      if (
        status === 429 ||
        status === 500 ||
        status === 503 ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT"
      ) {
        const baseDelay = 500; // ms
        const delay = Math.min(5000, baseDelay * 2 ** (attempt - 1));
        const jitter = Math.random() * 200; // up to 200ms jitter
        const wait = delay + jitter;
        console.warn(
          `Request failed (status=${status || err.code}). Retry ${attempt}/${attempts} in ${Math.round(
            wait
          )}ms...`
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      } else {
        throw err;
      }

    }
  }
  throw new Error(`Failed after ${attempts} attempts: ${config.url}`);
}

// Parse blood pressure string
function parseBP(bpRaw) {
  if (!bpRaw || typeof bpRaw !== "string") return { valid: false };

  const parts = bpRaw.split("/");
  
  if (parts.length !== 2) return { valid: false };
  
  const [sRaw, dRaw] = parts.map((s) => s.trim());
  const systolic = Number(sRaw);
  const diastolic = Number(dRaw);
  
  if (
    !isFinite(systolic) ||
    !isFinite(diastolic) ||
    sRaw === "" ||
    dRaw === "" ||
    sRaw.toUpperCase() === "N/A" ||
    dRaw.toUpperCase() === "N/A"
  ) {
    return { valid: false };
  }
  
  return { valid: true, systolic, diastolic };
}

// Blood pressure scoring per spec
function getBloodPressureScore(bpRaw) {
  const parsed = parseBP(bpRaw);
  if (!parsed.valid) return { score: 0, reason: "invalid_bp" };
  const { systolic, diastolic } = parsed;

  // Determine category separately then take higher risk
  let stage = 0;

  const isNormal = systolic < 120 && diastolic < 80;
  const isElevated = systolic >= 120 && systolic <= 129 && diastolic < 80;
  const isStage1 =
    (systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89);
  const isStage2 = systolic >= 140 || diastolic >= 90;

  if (isStage2) stage = 4;
  else if (isStage1) stage = 3;
  else if (isElevated) stage = 2;
  else if (isNormal) stage = 1;
  else {
    stage = 1;
  }

  return { score: stage, reason: "valid" };
}

// Temperature scoring
function getTemperatureScore(tempRaw) {
  if (tempRaw === null || tempRaw === undefined || tempRaw === "") return { score: 0, reason: "missing_temp" };
  const temp = Number(tempRaw);
  if (!isFinite(temp)) return { score: 0, reason: "invalid_temp" };

  if (temp >= 101.0) return { score: 2, reason: "high_fever" };
  if (temp >= 99.6 && temp <= 100.9) return { score: 1, reason: "low_fever" };
  if (temp <= 99.5) return { score: 0, reason: "normal" };

  return { score: 0, reason: "normal" };
}

// Age scoring
function getAgeScore(ageRaw) {
  if (ageRaw === null || ageRaw === undefined || ageRaw === "") return { score: 0, reason: "missing_age" };

  const age = Number(ageRaw);

  if (!isFinite(age)) return { score: 0, reason: "invalid_age" };
  if (age > 65) return { score: 2, reason: "over_65" };
  if (age >= 0) return { score: 1, reason: "under_or_mid" }; // under 40 and 40-65 are both 1
  
  return { score: 0, reason: "invalid_age" };
}

// Aggregate per patient
function computeRisk(patient) {
  const bpRes = getBloodPressureScore(patient.blood_pressure);
  const tempRes = getTemperatureScore(patient.temperature);
  const ageRes = getAgeScore(patient.age);

  const totalRisk = bpRes.score + tempRes.score + ageRes.score;

  const dataQualityProblems = [];
  if (bpRes.score === 0 && bpRes.reason !== "valid") dataQualityProblems.push("bp");
  if (tempRes.score === 0 && tempRes.reason.startsWith("invalid")) dataQualityProblems.push("temp");
  if (ageRes.score === 0 && ageRes.reason.startsWith("invalid")) dataQualityProblems.push("age");

  return {
    patient_id: patient.patient_id,
    scores: {
      blood_pressure: bpRes,
      temperature: tempRes,
      age: ageRes,
      total: totalRisk,
    },
    hasDataQualityIssue: dataQualityProblems.length > 0,
    dataQualityProblems,
    raw: patient,
  };
}

// Fetch all patients with pagination
async function fetchAllPatients() {
  let page = 1;
  const limit = 5;
  const all = [];
  while (true) {
    const url = `/patients?page=${page}&limit=${limit}`;
    let response;
    try {
      response = await requestWithRetry({ method: "GET", url });
    } catch (e) {
      console.error("Failed to fetch page", page, e.message);
      throw e;
    }

    if (!response || !Array.isArray(response.data)) {
      console.warn(`Unexpected format on page ${page}, skipping.`);
      break;
    }

    all.push(...response.data);

    const pagination = response.pagination || {};
    if (pagination.hasNext) {
      page += 1;
    } else {
      break;
    }
    
  }
  return all;
}

// Submit assessment
async function submitAssessment({ highRiskPatients, feverPatients, dataQualityIssues }) {
  const payload = {
    high_risk_patients: highRiskPatients,
    fever_patients: feverPatients,
    data_quality_issues: dataQualityIssues,
  };

  try {
    const result = await requestWithRetry({
      method: "POST",
      url: "/submit-assessment",
      data: payload,
    });
    return result;
  } catch (e) {
    console.error("Submission failed:", e.response?.data || e.message);
    throw e;
  }
}

(async () => {
  console.log("Fetching patients...");
  const patients = await fetchAllPatients();
  console.log(`Fetched ${patients.length} patients.`);

  const highRisk = new Set();
  const fever = new Set();
  const dataQuality = new Set();

  const breakdown = [];

  for (const p of patients) {
    if (!p.patient_id) continue;
    const r = computeRisk(p);
    breakdown.push(r);

    if (r.scores.total >= 4) highRisk.add(r.patient_id);
    const tempVal = Number(p.temperature);
    if (isFinite(tempVal) && tempVal >= 99.6) fever.add(r.patient_id);
    if (r.hasDataQualityIssue) dataQuality.add(r.patient_id);
  }

  const highRiskList = Array.from(highRisk).sort();
  const feverList = Array.from(fever).sort();
  const dataQualityList = Array.from(dataQuality).sort();

  console.log("=== Alert Lists ===");
  console.log("High-Risk Patients (score >=4):", highRiskList);
  console.log("Fever Patients (temp >=99.6°F):", feverList);
  console.log("Data Quality Issues:", dataQualityList);
  console.log("===================");

  // Optionally submit
  console.log("Submitting assessment...");
  try {
    const submissionResult = await submitAssessment({
      highRiskPatients: highRiskList,
      feverPatients: feverList,
      dataQualityIssues: dataQualityList,
    });
    console.log("Submission response:", JSON.stringify(submissionResult, null, 2));
  } catch (e) {
    console.error("Final submission failed.");
    process.exit(1);
  }
})();
