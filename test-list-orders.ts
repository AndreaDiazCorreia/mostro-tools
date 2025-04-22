import { Mostro, OrderSearchOptions } from './src/client/mostro';
import { OrderStatus } from './src/types/core';
// O si ya has construido el paquete: import { Mostro } from '@mostrop2p/mostro-tools';

/**
 * Función para mostrar órdenes de forma ordenada en la consola
 */
function displayOrders(orders: any[], title: string) {
  console.log(`\n===== ${title} (${orders.length} órdenes encontradas) =====`);
  if (orders.length === 0) {
    console.log('No se encontraron órdenes que coincidan con los criterios');
    return;
  }
  
  orders.forEach((order, index) => {
    console.log(`\nOrden #${index + 1}:`);
    console.log(`- ID: ${order.id}`);
    console.log(`- Tipo: ${order.kind}`);
    console.log(`- Estado: ${order.status}`);
    console.log(`- Moneda: ${order.fiat_code}`);
    console.log(`- Monto: ${order.amount === 0 ? 'Precio de mercado' : order.amount + ' sats'}`);
    console.log(`- Monto fiat: ${order.fiat_amount}`);
    console.log(`- Método de pago: ${order.payment_method}`);
    console.log(`- Plataforma: ${order.platform || 'No especificada'}`);
  });
}

async function testListOrders() {
  // Configura la instancia de Mostro sin especificar un pubkey específico
  // Esto nos permite buscar órdenes P2P en general, no solo de una instancia concreta
  const mostro = new Mostro({
    // No necesitamos un mostroPubKey específico para buscar órdenes P2P
    mostroPubKey: '', // Dejamos vacío para no suscribirnos a un Mostro específico
    relays: [
      'wss://relay.damus.io',
      'wss://relay.nostr.info',
      'wss://nostr.bitcoiner.social',
      'wss://relay.mostro.network',
      'wss://nostr.mutinywallet.com',
      'wss://relay.snort.social'
    ],
    debug: true // Activa el modo de depuración
  });

  try {
    // Conecta a los relays pero no nos suscribimos a eventos de un Mostro específico
    console.log('Conectando a los relays de Nostr...');
    await mostro.connect();
    console.log('Conectado exitosamente a los relays');

    console.log('\n🔍 PROBANDO MÉTODOS DE BÚSQUEDA DE ÓRDENES P2P');
    
    // 1. Búsqueda general de órdenes P2P (todas las plataformas)
    console.log('\n1. Buscando todas las órdenes P2P (cualquier plataforma)...');
    console.log('Esto puede tomar unos segundos mientras consultamos los relays...');
    const allP2POrders = await mostro.searchOrders({
      documentType: 'order',
    });
    displayOrders(allP2POrders, 'Todas las órdenes P2P pendientes');

    // 2. Filtrar solo órdenes de compra (buy)
    console.log('\n2. Buscando órdenes de compra (buy)...');
    const buyOrders = await mostro.searchBuyOrders();
    displayOrders(buyOrders, 'Órdenes de compra (buy)');

    // 3. Filtrar solo órdenes de venta (sell)
    console.log('\n3. Buscando órdenes de venta (sell)...');
    const sellOrders = await mostro.searchSellOrders();
    displayOrders(sellOrders, 'Órdenes de venta (sell)');

    // 4. Filtrar por moneda (USD)
    console.log('\n4. Buscando órdenes en USD...');
    const usdOrders = await mostro.searchOrdersByCurrency('USD');
    displayOrders(usdOrders, 'Órdenes en USD');

    // 5. Filtrar por método de pago
    console.log('\n5. Buscando órdenes con método de pago "bank transfer"...');
    const bankOrders = await mostro.searchOrdersByPaymentMethod('bank transfer');
    displayOrders(bankOrders, 'Órdenes con pago por transferencia bancaria');

    // 6. Combinando múltiples filtros
    console.log('\n6. Buscando órdenes de venta (sell) en VES con método de pago "face to face"...');
    const combinedFilters: OrderSearchOptions = {
      orderType: 'sell',
      currency: 'VES',
      paymentMethods: ['face to face'],
      status: OrderStatus.PENDING
    };
    const filteredOrders = await mostro.searchOrders(combinedFilters);
    displayOrders(filteredOrders, 'Órdenes filtradas (venta en VES cara a cara)');

    // 7. Filtrar por plataforma específica
    console.log('\n7. Buscando órdenes de la plataforma "mostrop2p"...');
    const mostroOrders = await mostro.searchOrders({
      platform: 'mostrop2p'
    });
    displayOrders(mostroOrders, 'Órdenes de Mostro');

    // 8. Filtrar por plataforma lnp2pbot
    console.log('\n8. Buscando órdenes de la plataforma "lnp2pbot"...');
    const lnp2pbotOrders = await mostro.searchOrders({
      platform: 'lnp2pbot'
    });
    displayOrders(lnp2pbotOrders, 'Órdenes de lnp2pbot');

  } catch (error) {
    console.error('Error al listar órdenes:', error);
  } finally {
    console.log('\n✅ Prueba de búsqueda completada');
    // Es buena práctica cerrar la conexión o manejar la salida limpiamente
    // process.exit(0);
  }
}

testListOrders().catch(console.error);