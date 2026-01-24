import { IntegrityReport } from "../integrityScanner";
import { BehaviorReport } from "./behaviorEngine";
import { TimingReport } from "./timingEngine";
import { RealityMetrics } from "./realityEngine";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface RiskSignal {
    key: string;
    label: string;
    score: number;
    explanation: string[];
}

export interface PrimaryRisk {
    label: string;
    score: number;
    explanation: string[];
}

function riskToScore(risk: RiskLevel): number {
    if (risk === "HIGH") return 3;
    if (risk === "MEDIUM") return 2;
    return 1;
}

export function getPrimaryRisk(
    integrity: IntegrityReport,
    behavior: BehaviorReport | null,
    timing: TimingReport,
    reality: RealityMetrics
): PrimaryRisk {
    const risks: RiskSignal[] = [
        {
            key: "contract",
            label: "Contract Control Risk",
            score: riskToScore(integrity.contractRisk),
            explanation: integrity.flags.filter(f => f.includes("Mint") || f.includes("Freeze")),
        },
        {
            key: "distribution",
            label: "Supply Concentration Risk",
            score: riskToScore(integrity.holderRisk),
            explanation: integrity.flags.filter(f => f.includes("Holder") || f.includes("Top 10")),
        },
        {
            key: "behavior",
            label: "Developer Behavior Risk",
            score: behavior ? riskToScore(behavior.behaviorRisk) : 1,
            explanation: behavior?.flags || [],
        },
        {
            key: "timing",
            label: "Market Timing Risk",
            score: riskToScore(timing.velocity === "EXHAUSTED" ? "HIGH" : timing.momentumScore < 30 ? "MEDIUM" : "LOW"),
            explanation: timing.signals,
        },
        {
            key: "reality",
            label: "Unrealistic Expectation Risk",
            score: riskToScore(reality.feasibility === "UNREALISTIC" ? "HIGH" : reality.feasibility === "UNLIKELY" ? "MEDIUM" : "LOW"),
            explanation: [reality.meaningQuote],
        },
    ];

    const sortedRisks = risks.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const priority: Record<string, number> = {
            contract: 5,
            distribution: 4,
            behavior: 3,
            timing: 2,
            reality: 1
        };
        return (priority[b.key] || 0) - (priority[a.key] || 0);
    });

    const primary = sortedRisks[0];

    return {
        label: primary.label,
        score: primary.score,
        explanation: primary.explanation.length > 0 ? primary.explanation : ["Current state assessed as baseline safe."]
    };
}
