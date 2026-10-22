// Memory-only ownership: closing/navigation is not an edit or a new draft.
// A different open context, account, or edit prevents late completion from
// consuming text that now belongs to another draft, even when text is equal.
export function createCaptureDraftOwnership() {
  let generation = 0
  let owner: { account: string | null; context: string } | undefined
  return {
    view(open: boolean, account: string | null, context: string) {
      if (owner && owner.account !== account || open && (!owner || owner.context !== context)) {
        generation++
        owner = { account, context }
      } else if (open && !owner) owner = { account, context }
    },
    edit() { generation++ },
    capture() { return generation },
    owns(token: number, context?: string) { return generation === token && (context === undefined || owner?.context === context) },
  }
}
