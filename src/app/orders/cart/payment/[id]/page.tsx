"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import Header from "@/app/_components/Header";
import { ChevronLeft, CreditCard, Banknote } from "lucide-react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { generateOrderNumber } from "@/app/_utils/orderNumberGenerator";
import { sendOrderConfirmationEmail } from "@/app/_utils/sendOrderEmail";
import axios from "axios";

// TypeScriptの型定義
interface CartItem {
  id: string;
  food_id: string;
  name: string;
  price: number;
  quantity: number;
  image_url: string;
  size: "regular" | "large";
  is_takeout: boolean;
  total_price: number;
}

interface Order {
  id: number;
  order_number: string;
  // 他のプロパティも必要に応じて追加
}

export default function PaymentPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<
    "cash" | "credit" | "paypay"
  >("cash");
  const [processingPayment, setProcessingPayment] = useState(false);

  useEffect(() => {
    const fetchCartItems = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      const { data, error } = await supabase
        .from("cart")
        .select("*, foods(*)")
        .eq("user_id", session.user.id);

      if (error) {
        toast.error("カート情報の取得に失敗しました。");
        return;
      }
      if (!data || data.length === 0) {
        toast.warn("カートが空です。");
        router.push("/");
        return;
      }

      const items: CartItem[] = data.map((item: any) => ({
        id: item.id,
        food_id: item.food_id,
        name: item.foods.name,
        price: item.foods.price,
        quantity: item.quantity,
        image_url: item.foods.image_url,
        size: item.size,
        is_takeout: item.is_takeout,
        total_price: item.total_price,
      }));
      setCartItems(items);
    };

    fetchCartItems();
  }, [router]);

  useEffect(() => {
    const { total, discount } = cartItems.reduce(
      (acc, item) => {
        acc.total += item.total_price;
        if (item.is_takeout) {
          // 例: 持ち帰りの場合に10円引き
          acc.discount += 10 * item.quantity;
        }
        return acc;
      },
      { total: 0, discount: 0 }
    );
    setTotalAmount(total);
    setDiscountAmount(discount);
  }, [cartItems]);

  /**
   * 注文を作成し、DBに保存する共通関数
   */
  const createOrder = async (
    paymentType: "cash" | "credit" | "paypay",
    status: string
  ): Promise<Order> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      throw new Error("ログインが必要です。");
    }

    if (cartItems.length === 0) {
      throw new Error("カートが空です。");
    }

    // 店舗ID取得
    let storeId = null;
    const { data: foodData } = await supabase
      .from("foods")
      .select("store_name")
      .eq("id", cartItems[0].food_id)
      .single();
    if (foodData) {
      const { data: storeData } = await supabase
        .from("stores")
        .select("id")
        .eq("name", foodData.store_name)
        .single();
      if (storeData) {
        storeId = storeData.id;
      }
    }

    if (!storeId) {
      storeId = 1;
      console.warn(
        "店舗IDが見つかりませんでした。デフォルトID:1を使用します。"
      );
    }

    const order_number = await generateOrderNumber(storeId);
    const finalAmount = totalAmount - discountAmount;

    // 注文データ作成
    const orderData = {
      user_id: session.user.id,
      store_id: storeId,
      total_amount: finalAmount,
      discount_amount: discountAmount,
      payment_method: paymentType,
      status: status,
      created_at: new Date().toISOString(),
      order_number,
    };

    // 注文データをDBに保存
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert(orderData)
      .select()
      .single();

    if (orderError) {
      throw new Error(`注文の保存に失敗しました: ${orderError.message}`);
    }
    if (!order) {
      throw new Error("注文データの作成後に、データの取得ができませんでした。");
    }

    // 注文詳細データをDBに保存
    const orderDetailsData = cartItems.map((item) => ({
      order_id: order.id,
      food_id: item.food_id,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      size: item.size,
      is_takeout: item.is_takeout,
      amount: item.total_price,
    }));

    const { error: detailsError } = await supabase
      .from("order_details")
      .insert(orderDetailsData);

    if (detailsError) {
      throw new Error(`注文詳細の保存に失敗しました: ${detailsError.message}`);
    }

    return order;
  };

  // PayPay決済処理
  const handlePayPayPayment = async () => {
    setProcessingPayment(true);
    try {
      const order = await createOrder("paypay", "pending");
      const finalAmount = totalAmount - discountAmount;
      const merchantPaymentId = `order_${order.id}_${Date.now()}`;

      const paymentPayload = {
        merchantPaymentId,
        amount: { amount: finalAmount, currency: "JPY" },
        orderDescription: `学食アプリ注文 - ${order.order_number}`,
        redirectUrl: `${window.location.origin}/orders/complete?orderId=${order.id}`,
        redirectType: "WEB_LINK",
      };

      const response = await axios.post("/api/paypay", paymentPayload);

      if (response.data?.data?.url) {
        window.location.href = response.data.data.url;
      } else {
        throw new Error("PayPayの決済URL取得に失敗しました。");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "PayPay決済に失敗しました。";
      toast.error(errorMessage);
      setProcessingPayment(false);
    }
  };

  // 現金・クレジット決済処理
  const handleProcessPayment = async () => {
    setProcessingPayment(true);
    try {
      const order = await createOrder(paymentMethod, "pending");
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userEmail = session?.user?.email;
      const userName = session?.user?.user_metadata?.name || "お客様";

      if (userEmail) {
        const emailOrderItems = cartItems.map((item) => ({
          id: item.food_id,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
        }));

        await sendOrderConfirmationEmail({
          to: userEmail,
          orderId: String(order.id),
          orderNumber: order.order_number,
          customerName: userName,
          orderItems: emailOrderItems,
          totalAmount: totalAmount - discountAmount,
          orderDate: new Date().toLocaleDateString("ja-JP"),
        });
      }

      if (session?.user.id) {
        await supabase.from("cart").delete().eq("user_id", session.user.id);
      }
      setCartItems([]);

      router.push(`/orders/complete?orderId=${order.id}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "決済処理に失敗しました。";
      toast.error(errorMessage);
      setProcessingPayment(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <Header cartCount={cartItems.length} />
      <ToastContainer position="top-center" autoClose={3000} hideProgressBar />

      <main className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
        {/* JSX部分は変更ありません */}
        <div className="mb-6">
          <button
            onClick={() => router.back()}
            className="flex items-center text-gray-600 hover:text-gray-800"
          >
            <ChevronLeft size={20} className="mr-1" />
            カートに戻る
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="md:col-span-2">
            <div className="bg-white rounded-lg shadow p-4 sm:p-6 mb-6">
              <h2 className="text-lg font-semibold mb-4">支払い方法の選択</h2>
              <div className="space-y-4">
                <label
                  className={`border rounded-lg p-4 flex items-center cursor-pointer ${paymentMethod === "cash" ? "border-blue-500 bg-blue-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="cash"
                    checked={paymentMethod === "cash"}
                    onChange={() => setPaymentMethod("cash")}
                    className="mr-3"
                  />
                  <Banknote size={24} className="mr-3 text-gray-600" />
                  <div>
                    <p className="font-medium">現金払い</p>
                    <p className="text-sm text-gray-500">
                      商品受け取り時にお支払いください
                    </p>
                  </div>
                </label>
                <label
                  className={`border rounded-lg p-4 flex items-center cursor-pointer ${paymentMethod === "credit" ? "border-blue-500 bg-blue-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="credit"
                    checked={paymentMethod === "credit"}
                    onChange={() => setPaymentMethod("credit")}
                    className="mr-3"
                  />
                  <CreditCard size={24} className="mr-3 text-gray-600" />
                  <div>
                    <p className="font-medium">クレジットカード</p>
                    <p className="text-sm text-gray-500">
                      商品受け取り時にお支払いください
                    </p>
                  </div>
                </label>
                <label
                  className={`border rounded-lg p-4 flex items-center cursor-pointer ${paymentMethod === "paypay" ? "border-blue-500 bg-blue-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value="paypay"
                    checked={paymentMethod === "paypay"}
                    onChange={() => setPaymentMethod("paypay")}
                    className="mr-3"
                  />
                  <div className="mr-3 w-6 h-6 bg-red-500 rounded text-white text-xs flex items-center justify-center font-bold">
                    P
                  </div>
                  <div>
                    <p className="font-medium">PayPay決済</p>
                    <p className="text-sm text-gray-500">QRコードで簡単決済</p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div>
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="text-lg font-semibold mb-3">注文内容</h2>
              <div className="space-y-2 mb-4">
                {cartItems.map((item) => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>
                      {item.name} {item.size === "large" ? "(大盛り)" : ""} ×{" "}
                      {item.quantity}
                    </span>
                    <span>¥{item.total_price.toLocaleString()}</span>
                  </div>
                ))}
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="flex justify-between">
                  <span>小計</span>
                  <span>¥{totalAmount.toLocaleString()}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>お持ち帰り割引</span>
                    <span>-¥{discountAmount.toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg pt-2 border-t">
                  <span>合計</span>
                  <span>
                    ¥{(totalAmount - discountAmount).toLocaleString()}
                  </span>
                </div>
              </div>

              <button
                onClick={
                  paymentMethod === "paypay"
                    ? handlePayPayPayment
                    : handleProcessPayment
                }
                disabled={processingPayment || cartItems.length === 0}
                className="w-full mt-6 py-3 bg-blue-600 text-white rounded-lg font-semibold disabled:bg-gray-400 flex justify-center items-center"
              >
                {processingPayment ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    処理中...
                  </>
                ) : (
                  `¥${(totalAmount - discountAmount).toLocaleString()} を支払う`
                )}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
