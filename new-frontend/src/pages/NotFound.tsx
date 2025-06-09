import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/retroui/Button";
import { Card, CardContent } from "@/components/retroui/Card";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-yellow-50 to-orange-50 flex items-center justify-center p-8">
      <Card className="max-w-md w-full">
        <CardContent className="p-8 text-center space-y-6">
          <div className="space-y-4">
            <h1 className="text-6xl font-bold bg-gradient-to-r from-orange-500 to-red-500 bg-clip-text text-transparent">
              404
            </h1>
            <h2 className="text-2xl font-bold text-gray-900">
              Oops! Page not found
            </h2>
            <p className="text-gray-600">
              Looks like you've wandered off the beaten path. Let's get you back
              to connecting with people!
            </p>
          </div>

          <div className="space-y-3">
            <Button
              onClick={() => (window.location.href = "/")}
              className="w-full"
              size="lg"
            >
              Return to Chizzy
            </Button>

            <p className="text-sm text-gray-500">
              Start meeting interesting people from around the world
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default NotFound;
