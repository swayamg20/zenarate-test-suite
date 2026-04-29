/**
 * Creates a demo workflow: Insurance Claims Intake Agent
 *
 * Flow:
 *   Greeting → collect caller_name → collect policy_number → set_value verified=true
 *   → condition(claim_type)
 *       → if "auto" → AutoClaim node (collect details, set_value)
 *       → if "home" → HomeClaim node (collect details, set_value)
 *       → else → GeneralClaim node (transfer)
 *   → EndCall (goodbye)
 *
 * Features exercised:
 *   - speak(exact) + speak(flexible)
 *   - collect with different types (String, Boolean, Integer)
 *   - set_value with type coercion
 *   - condition branching (3 paths)
 *   - private variable (internal_case_id)
 *   - end_conversation + EndCallNode
 *   - transfer step
 */

import { clientFromEnv } from "../src/zenarate/factory.ts";

async function main() {
  const c = await clientFromEnv();
  console.log("Creating workflow...");

  // 1. Create the workflow
  const wf = await c.workflow.workflowsCreate({
    title: "Insurance Claims Intake (Demo)",
    description: "Demo workflow for testing voice-eval. Multi-node insurance claims intake with branching by claim type.",
    bot_name: "Clara",
    company_name: "Zenith Insurance",
    company_description: "Zenith Insurance provides auto, home, and general insurance policies.",
    llm_config: {
      system_prompt: "You are Clara, a friendly insurance claims agent at Zenith Insurance. Be empathetic and professional. Collect information step by step. Keep responses concise.",
      llm_provider: "openai",
      llm_model_name: "gpt-4o-mini",
      temperature: 0.2,
      top_p: 1.0,
      top_k: 0,
      max_tokens: 500,
    },
  } as any);
  const wfId = (wf as any).id;
  console.log(`Workflow created: id=${wfId}`);

  // 2. Create nodes
  const intakeNode = await c.workflow.workflowsNodesCreate(wfId, {
    title: "ClaimsIntake",
    resourcetype: "LLMNode",
    description: "Greet caller, collect name, policy number, and claim type",
    block_type: "task_following",
    is_entrypoint: true,
    is_end: false,
    prompt: "Greet the caller, verify their identity by collecting name and policy number, then ask what type of claim they need to file.",
    respond_immediately: true,
  } as any);
  const intakeId = (intakeNode as any).id;
  console.log(`  ClaimsIntake node: id=${intakeId}`);

  const autoNode = await c.workflow.workflowsNodesCreate(wfId, {
    title: "AutoClaimDetails",
    resourcetype: "LLMNode",
    description: "Collect auto claim specifics: vehicle, date, damage description",
    block_type: "task_following",
    is_entrypoint: false,
    is_end: false,
    prompt: "Collect details about the auto insurance claim: vehicle info, accident date, and damage description.",
    respond_immediately: true,
  } as any);
  const autoId = (autoNode as any).id;
  console.log(`  AutoClaimDetails node: id=${autoId}`);

  const homeNode = await c.workflow.workflowsNodesCreate(wfId, {
    title: "HomeClaimDetails",
    resourcetype: "LLMNode",
    description: "Collect home claim specifics: property address, incident type, damage description",
    block_type: "task_following",
    is_entrypoint: false,
    is_end: false,
    prompt: "Collect details about the home insurance claim: property address, type of incident, and damage description.",
    respond_immediately: true,
  } as any);
  const homeId = (homeNode as any).id;
  console.log(`  HomeClaimDetails node: id=${homeId}`);

  const generalNode = await c.workflow.workflowsNodesCreate(wfId, {
    title: "GeneralClaimTransfer",
    resourcetype: "LLMNode",
    description: "For other claim types, transfer to a specialist",
    block_type: "task_following",
    is_entrypoint: false,
    is_end: false,
    prompt: "Inform the caller that their claim type requires a specialist and transfer them.",
    respond_immediately: true,
  } as any);
  const generalId = (generalNode as any).id;
  console.log(`  GeneralClaimTransfer node: id=${generalId}`);

  const endNode = await c.workflow.workflowsNodesCreate(wfId, {
    title: "ClaimFiled",
    resourcetype: "EndCallNode",
    description: "Confirm claim is filed and end the call",
    is_entrypoint: false,
    is_end: true,
    goodbye_message: "Your claim has been filed successfully. A claims adjuster will contact you within 24 hours. Thank you for calling Zenith Insurance.",
    goodbye_message_mode: "flexible",
  } as any);
  const endId = (endNode as any).id;
  console.log(`  ClaimFiled node: id=${endId}`);

  // 3. Create variables on ClaimsIntake
  const vars: Record<string, number> = {};

  for (const v of [
    { name: "caller_name", resourcetype: "StringVariable", description: "Caller's full name", is_required: true, access_mode: "settable", scope: "workflow", confirmation_mode: "explicit", node: intakeId },
    { name: "policy_number", resourcetype: "AlphanumericVariable", description: "Insurance policy number (format: POL-XXXX)", is_required: true, access_mode: "settable", scope: "workflow", confirmation_mode: "explicit", node: intakeId },
    { name: "claim_type", resourcetype: "StringVariable", description: "Type of claim: auto, home, or other", is_required: true, access_mode: "settable", scope: "workflow", node: intakeId },
    { name: "is_verified", resourcetype: "BooleanVariable", description: "Whether caller identity is verified", is_required: false, access_mode: "settable", scope: "workflow", node: intakeId },
    { name: "internal_case_id", resourcetype: "StringVariable", description: "Internal case tracking ID - never shown to caller", is_required: false, access_mode: "private", scope: "workflow", node: intakeId },
  ]) {
    const created = await c.workflow.workflowsNodesVariablesCreate(String(wfId), intakeId, v as any);
    vars[v.name] = (created as any).id;
    console.log(`    var ${v.name}: id=${(created as any).id}`);
  }

  // Variables on AutoClaimDetails
  for (const v of [
    { name: "vehicle_info", resourcetype: "StringVariable", description: "Vehicle make, model, year", is_required: true, access_mode: "settable", scope: "node", node: autoId },
    { name: "accident_date", resourcetype: "StringVariable", description: "Date of the accident", is_required: true, access_mode: "settable", scope: "node", node: autoId },
    { name: "damage_description", resourcetype: "StringVariable", description: "Description of damage to vehicle", is_required: true, access_mode: "settable", scope: "node", node: autoId },
    { name: "claim_reference", resourcetype: "StringVariable", description: "Generated claim reference number", is_required: false, access_mode: "settable", scope: "workflow", node: autoId },
    { name: "anyone_injured", resourcetype: "BooleanVariable", description: "Whether anyone was injured in the accident", is_required: true, access_mode: "settable", scope: "node", node: autoId },
  ]) {
    const created = await c.workflow.workflowsNodesVariablesCreate(String(wfId), autoId, v as any);
    vars[v.name] = (created as any).id;
    console.log(`    var ${v.name}: id=${(created as any).id}`);
  }

  // Variables on HomeClaimDetails
  for (const v of [
    { name: "property_address", resourcetype: "StringVariable", description: "Address of the property", is_required: true, access_mode: "settable", scope: "node", node: homeId },
    { name: "incident_type", resourcetype: "StringVariable", description: "Type of incident: fire, flood, storm, theft, other", is_required: true, access_mode: "settable", scope: "node", node: homeId },
    { name: "home_damage_description", resourcetype: "StringVariable", description: "Description of damage to property", is_required: true, access_mode: "settable", scope: "node", node: homeId },
    { name: "claim_reference_home", resourcetype: "StringVariable", description: "Generated claim reference number for home claims", is_required: false, access_mode: "settable", scope: "node", node: homeId },
    { name: "is_habitable", resourcetype: "BooleanVariable", description: "Whether the property is still habitable", is_required: true, access_mode: "settable", scope: "node", node: homeId },
  ]) {
    const created = await c.workflow.workflowsNodesVariablesCreate(String(wfId), homeId, v as any).catch(() => null);
    if (created) {
      vars[v.name] = (created as any).id;
      console.log(`    var ${v.name}: id=${(created as any).id}`);
    }
  }

  // 4. Create instruction steps on ClaimsIntake
  const intakeSteps = [
    { step_type: "speak", resourcetype: "SpeakStep", order: 1, mode: "exact", content: "Thank you for calling Zenith Insurance claims department. My name is Clara and I'll be assisting you today." },
    { step_type: "collect", resourcetype: "CollectStep", order: 2, variable: vars.caller_name, variable_name: "caller_name", custom_question: "May I have your full name, please?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 3, variable: vars.policy_number, variable_name: "policy_number", custom_question: "Could you provide your policy number? It starts with POL followed by four digits." },
    { step_type: "speak", resourcetype: "SpeakStep", order: 4, mode: "flexible", content: "Thank you. I've located your policy. Let me verify your account." },
    { step_type: "set_value", resourcetype: "SetValueStep", order: 5, variable: vars.is_verified, variable_name: "is_verified", value: "true" },
    { step_type: "set_value", resourcetype: "SetValueStep", order: 6, variable: vars.internal_case_id, variable_name: "internal_case_id", value: "CASE-2026-00421" },
    { step_type: "collect", resourcetype: "CollectStep", order: 7, variable: vars.claim_type, variable_name: "claim_type", custom_question: "What type of claim would you like to file? We handle auto, home, and general claims." },
  ];
  for (const step of intakeSteps) {
    await c.workflow.workflowsNodesInstructionStepsCreate(String(wfId), intakeId, { ...step, node: intakeId } as any);
  }
  console.log(`  Created ${intakeSteps.length} steps on ClaimsIntake`);

  // Steps on AutoClaimDetails
  const autoSteps = [
    { step_type: "speak", resourcetype: "SpeakStep", order: 1, mode: "exact", content: "I'll help you with your auto claim. I need to collect a few details." },
    { step_type: "collect", resourcetype: "CollectStep", order: 2, variable: vars.vehicle_info, variable_name: "vehicle_info", custom_question: "What is the make, model, and year of your vehicle?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 3, variable: vars.accident_date, variable_name: "accident_date", custom_question: "When did the accident occur?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 4, variable: vars.damage_description, variable_name: "damage_description", custom_question: "Can you describe the damage to your vehicle?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 5, variable: vars.anyone_injured, variable_name: "anyone_injured", custom_question: "Was anyone injured in the accident?" },
    { step_type: "set_value", resourcetype: "SetValueStep", order: 6, variable: vars.claim_reference, variable_name: "claim_reference", value: "AUTO-2026-" },
    { step_type: "end_conversation", resourcetype: "EndConversationStep", order: 7, goodbye_message: "Your auto claim has been filed. A claims adjuster will call you within 24 hours. Thank you." },
  ];
  for (const step of autoSteps) {
    await c.workflow.workflowsNodesInstructionStepsCreate(String(wfId), autoId, { ...step, node: autoId } as any);
  }
  console.log(`  Created ${autoSteps.length} steps on AutoClaimDetails`);

  // Steps on HomeClaimDetails
  const homeSteps = [
    { step_type: "speak", resourcetype: "SpeakStep", order: 1, mode: "exact", content: "I'll help you with your home insurance claim. Let me get the details." },
    { step_type: "collect", resourcetype: "CollectStep", order: 2, variable: vars.property_address, variable_name: "property_address", custom_question: "What is the address of the property?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 3, variable: vars.incident_type, variable_name: "incident_type", custom_question: "What type of incident occurred? For example: fire, flood, storm, or theft." },
    { step_type: "collect", resourcetype: "CollectStep", order: 4, variable: vars.home_damage_description, variable_name: "home_damage_description", custom_question: "Can you describe the damage to your property?" },
    { step_type: "collect", resourcetype: "CollectStep", order: 5, variable: vars.is_habitable, variable_name: "is_habitable", custom_question: "Is the property still safe to live in?" },
    { step_type: "set_value", resourcetype: "SetValueStep", order: 6, variable: vars.claim_reference_home, variable_name: "claim_reference_home", value: "HOME-2026-" },
    { step_type: "end_conversation", resourcetype: "EndConversationStep", order: 7, goodbye_message: "Your home claim has been filed. A claims adjuster will contact you within 24 hours. Thank you." },
  ];
  for (const step of homeSteps) {
    await c.workflow.workflowsNodesInstructionStepsCreate(String(wfId), homeId, { ...step, node: homeId } as any);
  }
  console.log(`  Created ${homeSteps.length} steps on HomeClaimDetails`);

  // Steps on GeneralClaimTransfer
  const generalSteps = [
    { step_type: "speak", resourcetype: "SpeakStep", order: 1, mode: "exact", content: "For your type of claim, I'll need to connect you with a specialist who can better assist you." },
    { step_type: "speak", resourcetype: "SpeakStep", order: 2, mode: "exact", content: "In case you get disconnected, you can call us back at 1-800-ZENITH-1, Monday through Friday, 8 AM to 6 PM Eastern." },
    { step_type: "transfer", resourcetype: "TransferStep", order: 3, phone_number: "+18009364841", goodbye_message: "In case you get disconnected, you can call us back at 1-800-ZENITH-1, Monday through Friday, 8 AM to 6 PM Eastern. Let me transfer you now.", goodbye_message_mode: "exact" },
  ];
  for (const step of generalSteps) {
    await c.workflow.workflowsNodesInstructionStepsCreate(String(wfId), generalId, { ...step, node: generalId } as any);
  }
  console.log(`  Created ${generalSteps.length} steps on GeneralClaimTransfer`);

  // 5. Create edges
  await c.workflow.workflowsEdgesCreate(wfId, {
    from_node: intakeId,
    to_node: autoId,
    order: 1,
    is_else: false,
    meta: { conditional_description: "Claim type is auto insurance" },
    condition_groups: [{ order: 0, is_else: false, title: "Auto claim", conditions: [{ order: 0, operator: "equal_to", value: "auto", variable: vars.claim_type, variable_name: "claim_type" }] }],
  } as any);
  console.log("  Edge: ClaimsIntake → AutoClaimDetails (claim_type=auto)");

  await c.workflow.workflowsEdgesCreate(wfId, {
    from_node: intakeId,
    to_node: homeId,
    order: 2,
    is_else: false,
    meta: { conditional_description: "Claim type is home insurance" },
    condition_groups: [{ order: 0, is_else: false, title: "Home claim", conditions: [{ order: 0, operator: "equal_to", value: "home", variable: vars.claim_type, variable_name: "claim_type" }] }],
  } as any);
  console.log("  Edge: ClaimsIntake → HomeClaimDetails (claim_type=home)");

  await c.workflow.workflowsEdgesCreate(wfId, {
    from_node: intakeId,
    to_node: generalId,
    order: 3,
    is_else: false,
    meta: { conditional_description: "Any other claim type (not auto or home)" },
    condition_groups: [{ order: 0, is_else: false, title: "Other claim", conditions: [{ order: 0, operator: "not_equal_to", value: "auto", variable: vars.claim_type, variable_name: "claim_type" }, { order: 1, operator: "not_equal_to", value: "home", variable: vars.claim_type, variable_name: "claim_type" }] }],
  } as any);
  console.log("  Edge: ClaimsIntake → GeneralClaimTransfer (not auto, not home)");

  await c.workflow.workflowsEdgesCreate(wfId, {
    from_node: autoId,
    to_node: endId,
    order: 1,
    is_else: false,
    meta: { conditional_description: "Auto claim filed, proceed to end" },
  } as any);
  console.log("  Edge: AutoClaimDetails → ClaimFiled");

  await c.workflow.workflowsEdgesCreate(wfId, {
    from_node: homeId,
    to_node: endId,
    order: 1,
    is_else: false,
    meta: { conditional_description: "Home claim filed, proceed to end" },
  } as any);
  console.log("  Edge: HomeClaimDetails → ClaimFiled");

  console.log(`\n✅ Workflow created: id=${wfId}`);
  console.log(`   Dashboard: https://zenarate-prod.vercel.app/agents/${wfId}`);
  console.log(`   Generate tests: curl -X POST http://localhost:3000/agents/${wfId}/generate-suite -H "Content-Type: application/json" -d '{}'`);
}

main().catch((e) => { console.error(e); process.exit(1); });
