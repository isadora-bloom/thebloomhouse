import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'decor_inventory',
  allowedFields: ['item_name', 'category', 'quantity', 'source', 'vendor_name', 'notes', 'leaving_instructions'],
  orderBy: 'category',
})

export const { GET, POST, PATCH, DELETE } = crud
