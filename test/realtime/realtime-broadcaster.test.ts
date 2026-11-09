import { describe, expect, it } from "vitest";
import {
  RealtimeBroadcaster,
  type RealtimeEvent,
} from "../../src/core/modules/realtime/application/realtime-broadcaster";

describe("RealtimeBroadcaster (Filtering for Agents vs Managers/Admins)", () => {
  it("entrega MESSAGE_RECEIVED sin restricción a usuarios con rol admin y manager", () => {
    const broadcaster = new RealtimeBroadcaster();
    const adminEvents: RealtimeEvent[] = [];
    const managerEvents: RealtimeEvent[] = [];

    broadcaster.subscribe({
      userId: "admin-1",
      departmentIds: new Set(),
      role: "admin",
      send: (e) => adminEvents.push(e),
    });

    broadcaster.subscribe({
      userId: "manager-1",
      departmentIds: new Set(["dept-support"]),
      role: "manager",
      send: (e) => managerEvents.push(e),
    });

    const unassignedTriageMsg: RealtimeEvent = {
      type: "MESSAGE_RECEIVED",
      conversationId: "conv-1",
      messageId: "msg-1",
      bodyPreview: "Hola",
      authorName: "Cliente",
      departmentId: null,
      assignedAgentId: null,
      isHumanActive: false,
    };

    broadcaster.publish(unassignedTriageMsg);

    expect(adminEvents).toHaveLength(1);
    expect(managerEvents).toHaveLength(1);
    expect(adminEvents[0]).toEqual(unassignedTriageMsg);
    expect(managerEvents[0]).toEqual(unassignedTriageMsg);
  });

  it("filtra MESSAGE_RECEIVED para rol agent: entrega si está asignado al agente", () => {
    const broadcaster = new RealtimeBroadcaster();
    const agent1Events: RealtimeEvent[] = [];
    const agent2Events: RealtimeEvent[] = [];

    broadcaster.subscribe({
      userId: "agent-1",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => agent1Events.push(e),
    });

    broadcaster.subscribe({
      userId: "agent-2",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => agent2Events.push(e),
    });

    const msgForAgent1: RealtimeEvent = {
      type: "MESSAGE_RECEIVED",
      conversationId: "conv-2",
      messageId: "msg-2",
      bodyPreview: "Mi internet ya vale gracias",
      departmentId: "dept-support",
      assignedAgentId: "agent-1",
      isHumanActive: true,
    };

    broadcaster.publish(msgForAgent1);

    expect(agent1Events).toHaveLength(1);
    expect(agent1Events[0]).toEqual(msgForAgent1);
    expect(agent2Events).toHaveLength(0);
  });

  it("filtra MESSAGE_RECEIVED para rol agent: entrega si pertenece a su departamento y está sin asignar", () => {
    const broadcaster = new RealtimeBroadcaster();
    const supportAgentEvents: RealtimeEvent[] = [];
    const salesAgentEvents: RealtimeEvent[] = [];

    broadcaster.subscribe({
      userId: "agent-support",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => supportAgentEvents.push(e),
    });

    broadcaster.subscribe({
      userId: "agent-sales",
      departmentIds: new Set(["dept-sales"]),
      role: "agent",
      send: (e) => salesAgentEvents.push(e),
    });

    const msgSupportQueue: RealtimeEvent = {
      type: "MESSAGE_RECEIVED",
      conversationId: "conv-3",
      messageId: "msg-3",
      departmentId: "dept-support",
      assignedAgentId: null,
      isHumanActive: true,
    };

    broadcaster.publish(msgSupportQueue);

    expect(supportAgentEvents).toHaveLength(1);
    expect(salesAgentEvents).toHaveLength(0);
  });

  it("NO entrega MESSAGE_RECEIVED de triage/bot inicial a agentes de departamentos específicos", () => {
    const broadcaster = new RealtimeBroadcaster();
    const agentEvents: RealtimeEvent[] = [];

    broadcaster.subscribe({
      userId: "agent-1",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => agentEvents.push(e),
    });

    const botTriageMsg: RealtimeEvent = {
      type: "MESSAGE_RECEIVED",
      conversationId: "conv-4",
      messageId: "msg-4",
      departmentId: null,
      assignedAgentId: null,
      isHumanActive: false,
    };

    broadcaster.publish(botTriageMsg);

    expect(agentEvents).toHaveLength(0);
  });

  it("filtra CASE_SCHEDULED_REMINDER: solo entrega al agente asignado o supervisores", () => {
    const broadcaster = new RealtimeBroadcaster();
    const agent1Events: RealtimeEvent[] = [];
    const agent2Events: RealtimeEvent[] = [];
    const managerEvents: RealtimeEvent[] = [];

    broadcaster.subscribe({
      userId: "agent-1",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => agent1Events.push(e),
    });

    broadcaster.subscribe({
      userId: "agent-2",
      departmentIds: new Set(["dept-support"]),
      role: "agent",
      send: (e) => agent2Events.push(e),
    });

    broadcaster.subscribe({
      userId: "manager-1",
      departmentIds: new Set(["dept-support"]),
      role: "manager",
      send: (e) => managerEvents.push(e),
    });

    const reminderAgent1: RealtimeEvent = {
      type: "CASE_SCHEDULED_REMINDER",
      caseId: "case-100",
      conversationId: "conv-100",
      assignedAgentId: "agent-1",
      departmentId: "dept-support",
      scheduledAt: new Date().toISOString(),
    };

    broadcaster.publish(reminderAgent1);

    expect(agent1Events).toHaveLength(1);
    expect(agent2Events).toHaveLength(0);
    expect(managerEvents).toHaveLength(1);
  });
});
