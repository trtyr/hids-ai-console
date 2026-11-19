import { AgentToolbox } from '../../../agent-tools.js';
import { InvestigationAgent } from '../../../investigation-agent.js';
const calls=[];
const toolbox=new AgentToolbox({listTools: async()=>[
  {name:'get_suspicious_operation_event',inputSchema:{properties:{id:{}},required:['id']}},
  {name:'submit_conclusion',inputSchema:{properties:{verdict:{},summary:{}}}}],
  callTool: async(n,a)=> (calls.push(n), n==='get_suspicious_operation_event'?{event_id:7,host_id:41,cmdline:'id'}:{total:0,events:[]})});
let n=0;
const model={model:'fake',complete: async(messages,tools)=>{
  if(!tools.length) return {content: JSON.stringify({assessment:'supported',concerns:[],missing_evidence:[]})};
  if(n++===0) return {tool_calls:[
    {id:'c-a',type:'function',function:{name:'submit_conclusion',arguments:JSON.stringify({verdict:'存疑',summary:'第一个结论-甲方'})}},
    {id:'c-b',type:'function',function:{name:'submit_conclusion',arguments:JSON.stringify({verdict:'存疑',summary:'第二个结论-乙方'})}}]};
  return {content: JSON.stringify({verdict:'存疑',summary:'第二轮'})};
}};
const r=await new InvestigationAgent(toolbox,model).run('suspicious_operation:7',{mode:'deep'});
console.log(JSON.stringify(r.verdict,null,1));
console.log(JSON.stringify(r.trace.filter(t=>t.kind==='conclusion'),null,1));
