
import { GoogleGenAI, Type } from "@google/genai";
import { PanoramaRule } from "../types";

const API_KEY = process.env.API_KEY;

export const analyzeRulesWithAI = async (rules: PanoramaRule[], unusedDays: number): Promise<string> => {
  if (!API_KEY) return "AI Analysis unavailable: No API Key.";

  const ai = new GoogleGenAI({ apiKey: API_KEY });
  
  const prompt = `
    Analyze these Palo Alto Panorama firewall rules based on a ${unusedDays}-day inactivity threshold.
    
    Rules:
    ${JSON.stringify(rules.map(r => ({
      name: r.name,
      dg: r.deviceGroup,
      hits: r.totalHits,
      lastHit: r.lastHitDate,
      targets: r.targets,
      isShared: r.isShared
    })))}

    Instructions:
    1. Identify which rules should be disabled (0 total hits in last ${unusedDays} days).
    2. Identify rules that need "Partial Untargeting" (Used on some firewalls but not others).
    3. Note that 'Shared' device group rules MUST be ignored.
    4. Provide a professional summary of the security impact of cleaning these rules.
    5. Generate the expected 'PAN-OS XML API' command format for one of the 'Disable' actions as an example.
    
    Return the response in clear Markdown.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        thinkingConfig: { thinkingBudget: 4000 }
      }
    });
    return response.text || "No analysis generated.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "An error occurred during AI analysis.";
  }
};
