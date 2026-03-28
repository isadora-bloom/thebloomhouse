import { createCoupleCrud } from '@/lib/api/couple-crud'

const crud = createCoupleCrud({
  table: 'shuttle_schedule',
  allowedFields: ['route_name', 'pickup_location', 'dropoff_location', 'departure_time', 'capacity', 'notes'],
  orderBy: 'departure_time',
})

export const { GET, POST, PATCH, DELETE } = crud
