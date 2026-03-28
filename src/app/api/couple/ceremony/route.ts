import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'ceremony_order',
  allowedFields: ['participant_name', 'role', 'side', 'sort_order', 'notes'],
  orderBy: 'sort_order',
})

export const { GET, POST, PATCH, DELETE } = crud
