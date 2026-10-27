/** Evidence finalization only; never changes a product result or cleanup policy. */
export async function finishReclamationRun({report,primaryError,close,verifySource,save}){
 const errors=primaryError?[primaryError]:[]
 report.finalization=[]
 for(const [label,action] of [['owned-cleanup',close],['frozen-source',verifySource]]){
  try{await action();report.finalization.push({label,status:'PASS'})}
  catch(error){errors.push(error);report.finalization.push({label,status:'FAIL',errorName:error?.name??'UnknownError'})}
 }
 report.status=errors.length?'FAIL':'PASS'
 try{save()}catch(error){errors.push(error);report.status='FAIL'}
 if(errors.length)throw new AggregateError(errors,'Reclamation acceptance or finalization failed')
}
